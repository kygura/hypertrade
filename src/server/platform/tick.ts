import { acquireLease, releaseLease, sql } from "../db.js";
import { createNotifier } from "../desk/notify.js";
import { createAlerts } from "./alerts.js";
import { createNoveltyLoop } from "./noveltyLoop.js";
import { createOutcomesLoop, type OutcomesDeps } from "./outcomesLoop.js";
import { createScanner, type Info, type ScannerDeps } from "./scanner.js";
import { retentionDays as retentionDays_, scanRetentionDays, type PlatformStore } from "./store.js";
import { PgPlatformStore } from "./store-pg.js";

// One platform tick without an always-on server: scanner -> novelty -> outcomes -> prune, in that order. Pure
// orchestration: store, clock, HL info and logger are injected. Callers: scripts/platform-tick.ts (all four steps,
// GitHub Actions and the routine) and POST /api/cron/platform-tick (routes/cronPlatform.ts: novelty excluded, deadline; POST /api/cron/novelty runs it).
// Each tick builds a fresh scanner, so its ring comes from stored scan_snapshots (+ seedFrom) and one 5-min snapshot
// row per live coin is written per tick: ticks every 15 min give the features their one point per 15 min.

const TICK_STEPS = ["scanner", "novelty", "outcomes", "prune"] as const;
export type TickStep = (typeof TICK_STEPS)[number];

type TickStepResult =
  | { name: TickStep; status: "ok" | "failed"; ms: number; error?: string }
  | { name: TickStep; status: "skipped"; reason: string };

export interface TickReport {
  ok: boolean;
  ms: number;
  steps: TickStepResult[];
  failed: TickStep[];
  /** scan_snapshots rows this tick wrote (one per live coin). */
  snapshotRows: number;
  /** Setups that fired this scan (before cooldown), i.e. opportunity candidates. */
  candidates: number;
  /** Opportunities upserted, and how many of them were new. */
  opportunities: { upserted: number; created: number };
  nearMisses: number;
  /** Median minutes of ring history per coin after the scan (scanner.historyMin); null without a scan. */
  ringMinutes: number | null;
  /** Rows pruneHistory dropped; null when prune did not run. */
  pruned: number | null;
}

export interface PlatformTickDeps {
  store: PlatformStore;
  info?: Info;
  now?: () => number;
  /** Extra cold-start ring history (intel_snapshots); see ScannerDeps.seedFrom. */
  seedFrom?: ScannerDeps["seedFrom"];
  fillPx?: OutcomesDeps["fillPx"];
  candles?: OutcomesDeps["candles"];
  /** Builds the novelty pass; only called when novelty runs. Absent: novelty is reported skipped. */
  novelty?: (o: { store: PlatformStore; nearMiss: ReturnType<typeof createScanner>["nearMiss"] }) => { tick: () => Promise<void> };
  log?: (line: string) => void;
  logError?: (line: string, err: unknown) => void;
}

export interface TickOptions {
  skip?: Iterable<string>;
  /** Why a skipped step was skipped (default "skipped by caller"). */
  skipReason?: Partial<Record<TickStep, string>>;
  /** Epoch ms (on deps.now) after which no step starts. A step starts only with reserveMs[step] left. */
  deadline?: number;
  reserveMs?: Partial<Record<TickStep, number>>;
  /** Live report: the route answers with it if a step hangs past its hard stop. */
  report?: TickReport;
}

export const emptyReport = (): TickReport => ({
  ok: true, ms: 0, steps: [], failed: [], snapshotRows: 0, candidates: 0, opportunities: { upserted: 0, created: 0 }, nearMisses: 0, ringMinutes: null, pruned: null,
});

/** Store wrapper that counts what a tick wrote; every other call passes straight through. */
function countingStore(store: PlatformStore, r: TickReport): PlatformStore {
  return new Proxy(store, {
    get(target, prop) {
      const v = Reflect.get(target, prop, target);
      if (typeof v !== "function") return v;
      if (prop === "insertScanSnapshots") return async (...a: Parameters<PlatformStore["insertScanSnapshots"]>) => ((r.snapshotRows += await target.insertScanSnapshots(...a)), r.snapshotRows);
      // The scanner reads a candidate's cooldown key first, once per fired setup.
      if (prop === "lastTerminalAt") return (...a: Parameters<PlatformStore["lastTerminalAt"]>) => (r.candidates++, target.lastTerminalAt(...a));
      if (prop === "upsertOpportunity")
        return async (...a: Parameters<PlatformStore["upsertOpportunity"]>) => {
          const res = await target.upsertOpportunity(...a);
          r.opportunities.upserted++;
          if (res.created) r.opportunities.created++;
          return res;
        };
      if (prop === "saveNearMisses") return (...a: Parameters<PlatformStore["saveNearMisses"]>) => ((r.nearMisses = a[1].length), target.saveNearMisses(...a));
      return v.bind(target);
    },
  });
}

/** Runs the steps in order. Each step runs even if an earlier one failed; never throws (failures are in the report). */
export async function runPlatformTick(deps: PlatformTickDeps, opts: TickOptions = {}): Promise<TickReport> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((l: string) => console.log(l));
  const logError = deps.logError ?? ((l: string, err: unknown) => console.error(l, err));
  const report = opts.report ?? emptyReport();
  const started = now();
  const store = countingStore(deps.store, report);
  const scanner = createScanner({ store, info: deps.info, now, seedFrom: deps.seedFrom });
  // No ws: pricing comes from the scan's mark (same process, just taken) and 1-min candles for late horizons.
  const outcomes = createOutcomesLoop({ store, mid: () => null, scanMark: scanner.latestMark, fillPx: deps.fillPx, candles: deps.candles, now });
  const prune = async () => {
    const t = now();
    report.pruned = await store.pruneHistory(new Date(t - retentionDays_() * 86_400_000).toISOString(), new Date(t - scanRetentionDays() * 86_400_000).toISOString());
  };
  const skip = new Set(opts.skip ?? []);
  const run: Record<TickStep, (() => Promise<void>) | null> = {
    scanner: async () => {
      await scanner.tick();
      report.ringMinutes = scanner.historyMin();
    },
    novelty: deps.novelty ? () => deps.novelty!({ store, nearMiss: scanner.nearMiss }).tick() : null,
    outcomes: outcomes.tick,
    prune,
  };
  for (const name of TICK_STEPS) {
    const step = run[name];
    const left = opts.deadline == null ? Infinity : opts.deadline - now();
    const need = opts.reserveMs?.[name] ?? 0;
    const reason = skip.has(name) ? (opts.skipReason?.[name] ?? "skipped by caller") : !step ? "not configured" : left < need ? `deadline: ${Math.max(0, Math.round(left))} ms left, step needs ${need} ms` : null;
    if (reason) {
      report.steps.push({ name, status: "skipped", reason });
      log(`[tick] ${name} skipped: ${reason}`);
      continue;
    }
    const t0 = now();
    try {
      await step!();
      report.steps.push({ name, status: "ok", ms: now() - t0 });
      log(`[tick] ${name} ok`);
    } catch (err) {
      report.failed.push(name);
      report.ok = false;
      report.steps.push({ name, status: "failed", ms: now() - t0, error: err instanceof Error ? err.message : String(err) });
      logError(`[tick] ${name} failed:`, err);
    }
  }
  report.ms = now() - started;
  return report;
}

/** sync_state lease row (coin '_platform', series 'tick') shared by the script and the HTTP route: one tick at a time. */
export const platformLease = {
  acquire: (holder: string, ttlMs: number) => acquireLease("_platform", "tick", holder, ttlMs),
  release: (holder: string) => releaseLease("_platform", "tick", holder),
};

/** Postgres-backed deps (needs DATABASE_URL): the pg store, intel_snapshots seed, desk paper fills and the novelty pass. */
export function pgTickDeps(): PlatformTickDeps {
  return {
    store: new PgPlatformStore(),
    // Same cold-start source as scripts/server.ts: intel_snapshots (15-min rows) fills the ring until scan_snapshots has its own history.
    seedFrom: async (since: string) =>
      (await sql()`select asset, ts, price, vol24h, funding, oi_usd from intel_snapshots where ts >= ${since} order by ts`).map((r: any) => ({
        coin: String(r.asset), ts: new Date(r.ts).toISOString(), inputs: { mark: r.price, oiUsd: r.oi_usd, funding: r.funding, dayNtlVlm: r.vol24h },
      })),
    fillPx: async (id) => {
      if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
      const [r] = await sql()`select px from desk_paper_fills where proposal_id = ${id} order by ts asc limit 1`;
      return r ? Number(r.px) : null;
    },
    novelty: pgNovelty,
  };
}

/** sync_state lease row (coin '_platform', series 'novelty') of POST /api/cron/novelty: its own, so it never blocks the tick. */
export const noveltyLease = {
  acquire: (holder: string, ttlMs: number) => acquireLease("_platform", "novelty", holder, ttlMs),
  release: (holder: string) => releaseLease("_platform", "novelty", holder),
};

/** The novelty pass over a store, pushing NOVEL alerts: the tick's novelty step and the HTTP job build the same one. */
export function pgNovelty({ store, nearMiss }: { store: PlatformStore; nearMiss?: (coin: string) => { setupKind: string } | null }) {
  const alerts = createAlerts({ store, notifier: createNotifier(), wsAgeSec: () => null });
  return createNoveltyLoop({ store, notify: alerts.novel, nearMiss });
}
