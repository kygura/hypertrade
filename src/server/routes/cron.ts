import { randomUUID } from "node:crypto";
import { Hono, type Context } from "hono";
import { hlWeightWaitMs } from "../../shared/hl-client.js";
import { TF_RETENTION_MS, TIMEFRAMES, type Timeframe } from "../../shared/timeframes.js";
import { requireCronToken } from "../auth.js";
import { collectCoinalyze, flowCoins, maxFlowCoins, type FlowCollectResult } from "../collectors/coinalyze.js";
import { collectCryptoContext } from "../collectors/cryptoContext.js";
import { batchSize, CollectBatchSchema, createBatchSink, emptyBatch, flushBatch, mergeBatches, type BatchWriter } from "../collectors/batch.js";
import { collectElfa, defaultElfaDeps } from "../collectors/elfa.js";
import { collectFred } from "../collectors/fred.js";
import type { CollectorResult } from "../collectors/types.js";
import { collectHyperliquid } from "../collectors/hyperliquid.js";
import * as db from "../db.js";
import { collectLab, LAB_SYNC_COIN, type LabCollectResult, type LabProgress } from "../lab/collect.js";
import { syncHead } from "../market/candleSync.js";
import { syncFunding } from "../market/fundingSync.js";
import { backfillCoin } from "../sim/backfill.js";
import { STABLES } from "../../shared/schemas.js";
import type { AssetCtx } from "../../shared/types.js";
import { runIntelWatch } from "../intel/docwatch.js";
import { flowAlerts } from "../intel/flowEvents.js";
import { refreshGraph } from "../intel/graph.js";
import { AUTO_RESEARCH_MARGIN_MS, autoResearch, RESEARCH_DEADLINE_MS, type AutoResearchDeps, type AutoResearchRun } from "../intel/research.js";
import { runIntelIngest } from "../intel/runIngest.js";
import { collectIntelSnapshots, fetchL2Book, focusAssets, SNAPSHOT_RETENTION_DAYS, STOP_RETENTION_DAYS, type SnapshotResult } from "../intel/snapshot.js";
import type { IntelStore } from "../intel/store.js";
import { runIntelBrief } from "../intel/terminal.js";
import { defaultIntelDeps } from "./intel/index.js";

const DAY_MS = 86400000;
const DEFAULT_BACKFILL_DAYS = 365;
/** Always kept warm, so charts have history before anyone opens them. */
export const CORE_COINS = ["BTC", "ETH", "SOL", "HYPE"];
/** A coin charted within this window stays warm (LTF bars, funding, OI snapshots). */
const RECENT_MS = 7 * DAY_MS;
/**
 * Stop starting new work after this. Vercel kills the function at 300s and the
 * collect workflow's curl gives up at 280s. A step already running can still
 * make one more HL call (up to 60s on the weight guard, then 41s with timeout
 * and retry) or external page, plus DB writes, so the budget leaves ~110s.
 */
const WARM_BUDGET_MS = 170_000;
/**
 * Answer by now whatever is still running. If a step hangs past the budget,
 * the route still returns what it has (and names the step) instead of being
 * killed at 300s with nothing to show for it.
 */
const HARD_STOP_MS = 240_000;
/**
 * A full funding page weighs 45 (20 + 1 per 20 rows) against HL's 1000/min
 * guard; 20 pages stalled each coin ~60s on the guard and starved the rest.
 * 4 pages still covers the head (one page is ~3 weeks) and walks history
 * back ~3 months per run.
 */
const FUNDING_PAGES_PER_RUN = 4;
/**
 * Lab history (its own route, /cron/lab-collect): no series starts after this
 * and every upstream request is cut to end by it, so the run ends a little
 * after (the last DB writes) — well inside Vercel's 300 s and the workflow
 * curl's 290 s.
 */
export const LAB_BUDGET_MS = 200_000;
/** The run lease outlives the budget by a minute: a run killed mid-way frees it after that. */
export const LAB_LEASE_MS = LAB_BUDGET_MS + 60_000;
/**
 * Answer by now whatever is still running: the last series' DB writes after
 * the budget each get up to the 30 s query timeout (src/server/db.ts), and a
 * hang there must still end in a response, not Vercel's 300 s kill.
 */
export const LAB_HARD_STOP_MS = LAB_BUDGET_MS + 40_000;
/** sync_state row (coin '_lab') whose synced_at is the Lab run lease's expiry. */
export const LAB_LEASE_SERIES = "_lease";

export type WarmResult = { from?: string; to?: string; tfs: number; fundingFrom?: string | null };

export type BackfillDeps = {
  listBranches: () => Promise<{ config: unknown }[]>;
  recentCoins: () => Promise<string[]>;
  /** Intel held ∪ watched coins (candles for ATR, priced-in and journal stats). */
  intelCoins?: () => Promise<string[]>;
  /** Daily history to startDate, head sync of every timeframe, funding pages. Calls `step` before each one. */
  warmCoin: (coin: string, startDate: Date, deadline: number, step: (label: string) => void) => Promise<WarmResult>;
  /** Retention for the finest timeframes; returns rows dropped per timeframe. */
  prune: () => Promise<Record<string, number>>;
  now: () => number;
  hardStopMs?: number;
};

/**
 * Room to start another step: counts the wait HL's weight guard would impose
 * first (up to 60s once a run has spent its per-minute budget), which a plain
 * clock check misses.
 */
const canStart = (deadline: number) => Date.now() + hlWeightWaitMs() < deadline;

export async function warmCoin(
  coin: string,
  startDate: Date,
  deadline: number,
  step: (label: string) => void = () => {},
): Promise<WarmResult> {
  if (canStart(deadline)) {
    step(`${coin} 1d history`);
    await backfillCoin(coin, startDate, undefined, deadline);
  }
  // Head sync every timeframe: HL keeps only the latest 5000 bars, so this is
  // what lets 1m/5m/15m history outlive HL's window.
  let tfs = 0;
  for (const tf of TIMEFRAMES) {
    if (!canStart(deadline)) break;
    step(`${coin} head ${tf}`);
    await syncHead(coin, tf, undefined, true, deadline);
    tfs++;
  }
  let f = null;
  if (canStart(deadline)) {
    step(`${coin} funding`);
    f = await syncFunding(coin, 0, { maxPages: FUNDING_PAGES_PER_RUN, deadline });
  }
  step(`${coin} coverage`);
  const coverage = await db.candleCoverage(coin, "1d");
  return {
    from: coverage?.min.toISOString(),
    to: coverage?.max.toISOString(),
    tfs,
    fundingFrom: f?.from != null ? new Date(f.from).toISOString() : null,
  };
}

export async function pruneRetention(now: number = Date.now()): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const [tf, keep] of Object.entries(TF_RETENTION_MS) as [Timeframe, number][]) {
    out[tf] = await db.pruneCandles(tf, new Date(now - keep));
  }
  return out;
}

/** Intel held ∪ watched assets. Only the coin set matters here, so manual positions go unpriced (empty marks). */
function intelFocus() {
  const intel = defaultIntelDeps();
  return focusAssets(() => intel.exposure({}), () => intel.watched());
}

async function intelCoins(): Promise<string[]> {
  const f = await intelFocus();
  return [...new Set([...f.held, ...f.watched])];
}

/** Candle retention, plus Intel snapshots and flow rows past SNAPSHOT_RETENTION_DAYS and stops past STOP_RETENTION_DAYS (`intel_snapshots`, `intel_flow`, `intel_stops`). */
async function pruneAll(now: number = Date.now()): Promise<Record<string, number>> {
  const out = await pruneRetention(now);
  const snapshotCutoff = new Date(now - SNAPSHOT_RETENTION_DAYS * DAY_MS);
  const jobs: Array<[string, () => Promise<number>]> = [
    ["intel_snapshots", () => defaultIntelDeps().store.pruneSnapshots(snapshotCutoff)],
    ["intel_flow", () => defaultIntelDeps().store.pruneFlow(snapshotCutoff)],
    ["intel_research", () => defaultIntelDeps().store.pruneResearch(snapshotCutoff)],
    ["intel_stops", () => defaultIntelDeps().store.pruneStops(new Date(now - STOP_RETENTION_DAYS * DAY_MS))],
  ];
  for (const [name, fn] of jobs) {
    try {
      out[name] = await fn();
    } catch (err) {
      console.error(`[backfill] ${name} prune:`, err instanceof Error ? err.message : err);
    }
  }
  return out;
}

/** Book fetches for the snapshot rows stop starting after this; the rows are written regardless. */
const SNAPSHOT_BOOK_BUDGET_MS = 60_000;
/** Snapshot books and the flow collector share this, measured from the start of the collect request; flow gets what is left. */
const COLLECT_BUDGET_MS = 90_000;
/** Cap on each database read the collect's fetch phase still makes (OI coins, Intel focus, Elfa throttle). */
const COLLECT_READ_MS = 5_000;
/** The collect's one write phase. The workflow's curl allows 120 s for the whole request. */
export const FLUSH_BUDGET_MS = 25_000;
/** A spill still holding rows this old fails the collect: the database has been unwritable for hours. */
export const SPILL_ALARM_MS = 6 * 3_600_000;

/** `p`, or `fallback` once `ms` pass (p keeps running; its late result or error is dropped). */
function capped<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p.catch(() => fallback), new Promise<T>((ok) => (timer = setTimeout(() => ok(fallback), ms)))]).finally(() => clearTimeout(timer));
}

const collectWriter = (): BatchWriter => {
  const store = defaultIntelDeps().store;
  return {
    ensureSeries: db.ensureSeries,
    upsertObservations: db.upsertObservations,
    insertSnapshots: (rows) => store.insertSnapshots(rows),
    recordStops: (rows) => store.recordStops(rows),
    insertCollectorRuns: db.insertCollectorRuns,
  };
};

/** Intel snapshot rows from the collect's own metaAndAssetCtxs, into the collect's batch. Never throws (failures land in collector_runs). */
function runIntelSnapshots(ctxs: AssetCtx[], ts: Date, collectDeadline: number, sink: ReturnType<typeof createBatchSink>): Promise<SnapshotResult> {
  const focus = () => capped(intelFocus(), COLLECT_READ_MS, { held: [], watched: [], stops: [], errors: [`focus: no answer from the database in ${COLLECT_READ_MS / 1000}s`] });
  return collectIntelSnapshots(
    { store: sink.store, focus, l2Book: (coin) => fetchL2Book(coin), recordRun: sink.db.recordCollectorRun, deadline: Math.min(Date.now() + SNAPSHOT_BOOK_BUDGET_MS, collectDeadline) },
    ctxs,
    ts,
  );
}

/** Coinalyze flow rows for held ∪ watched (capped), after the snapshot write. Never throws (failures land in collector_runs). */
function runIntelFlow(ctxs: AssetCtx[], collectDeadline: number): Promise<FlowCollectResult> {
  const intel = defaultIntelDeps();
  const env = intel.env ?? process.env;
  const marks = Object.fromEntries(ctxs.map((c) => [c.name, c.markPx]));
  return collectCoinalyze({
    fetch,
    store: intel.store,
    recordRun: db.recordCollectorRun,
    env,
    now: () => Date.now(),
    budgetMs: collectDeadline - Date.now(), // capped at FLOW_BUDGET_MS by the collector
    coins: async () => {
      const [exposure, watched] = await Promise.all([intel.exposure(marks), intel.watched()]);
      return flowCoins(exposure.positions, watched, maxFlowCoins(env));
    },
  });
}

const defaultBackfillDeps: BackfillDeps = {
  listBranches: db.listBranches,
  recentCoins: () => db.recentlyAccessedCoins(new Date(Date.now() - RECENT_MS)),
  intelCoins,
  warmCoin,
  prune: () => pruneAll(),
  now: () => Date.now(),
};

/** Core coins, then every coin a saved branch allocates to, then recently charted coins, then Intel held ∪ watched. Deduped, stables dropped. */
export function backfillCoins(branchConfigs: unknown[], requested?: string, recent: string[] = [], intel: string[] = []): string[] {
  if (requested) return [...new Set(requested.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean))];
  const coins = new Set(CORE_COINS);
  for (const config of branchConfigs) {
    const c = config as { allocations?: { coin?: unknown }[]; dca?: { coin?: unknown }[] } | null;
    for (const a of [...(c?.allocations ?? []), ...(c?.dca ?? [])]) if (typeof a.coin === "string") coins.add(a.coin.toUpperCase());
  }
  for (const c of [...recent, ...intel]) coins.add(c);
  return [...coins].filter((c) => !STABLES.has(c));
}

/**
 * Keeps chart history warm without a browser session: daily history for the
 * simulator, a head sync of every timeframe (the only way LTF history
 * survives HL's 5000-bar window), and funding pages. Idempotent, sequential
 * (public rate limits), and deadline-bounded — coins it doesn't reach are
 * reported as skipped and come first-served on the next run. One coin
 * failing does not stop the rest.
 */
export function backfillRoute(deps: BackfillDeps = defaultBackfillDeps) {
  return async (c: Context) => {
    const started = deps.now();
    const deadline = started + WARM_BUDGET_MS;
    const days = Number(c.req.query("days") ?? DEFAULT_BACKFILL_DAYS);
    if (!Number.isFinite(days) || days < 1 || days > 3650) return c.json({ error: "days must be 1-3650" }, 400);
    const startDate = new Date(started - days * DAY_MS);
    const requested = c.req.query("coins");
    let coins: string[] = [];

    const results: Record<string, { ok: boolean; skipped?: boolean; error?: string } & Partial<WarmResult>> = {};
    let pruned: Record<string, number> | { error: string } | { skipped: true } = { skipped: true };
    // Every step is logged with its start offset, so a slow one shows up in
    // the runtime logs as the gap before the next line.
    let current = "start";
    const step = (label: string) => {
      current = label;
      console.log(`[backfill] +${((deps.now() - started) / 1000).toFixed(1)}s ${label}`);
    };

    // Coin listing runs inside the hard stop too: a hung DB query here used to
    // leave the route silent until Vercel killed it at 300s.
    const work = (async () => {
      step("list coins");
      const [branches, recent, intel] = requested
        ? [[], [], []]
        : await Promise.all([deps.listBranches(), deps.recentCoins().catch(() => []), (deps.intelCoins?.() ?? Promise.resolve([])).catch(() => [])]);
      coins = backfillCoins(branches.map((b) => b.config), requested, recent, intel);
      for (const coin of coins) {
        if (deps.now() > deadline) {
          results[coin] = { ok: false, skipped: true };
          continue;
        }
        try {
          results[coin] = { ok: true, ...(await deps.warmCoin(coin, startDate, deadline, step)) };
        } catch (err) {
          results[coin] = { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      }
      if (deps.now() <= deadline) {
        step("prune");
        pruned = await deps.prune().catch((err) => ({ error: err instanceof Error ? err.message : String(err) }));
      }
      step("done");
    })();

    let timer: ReturnType<typeof setTimeout> | undefined;
    const hardStop = new Promise<"stop">((resolve) => {
      timer = setTimeout(() => resolve("stop"), deps.hardStopMs ?? HARD_STOP_MS);
    });
    const outcome = await Promise.race([work.then(() => "done" as const), hardStop]);
    clearTimeout(timer);
    if (outcome === "stop") {
      console.error(`[backfill] hard stop; still in "${current}"`);
      work.catch((err) => console.error("[backfill] after hard stop:", err));
      for (const coin of coins) results[coin] ??= { ok: false, skipped: true };
      return c.json({ days, results, pruned, timedOut: true, inFlight: current });
    }
    return c.json({ days, results, pruned });
  };
}

async function oiCoins(): Promise<string[]> {
  const [branches, recent, intel] = await Promise.all([
    db.listBranches().catch(() => []),
    db.recentlyAccessedCoins(new Date(Date.now() - RECENT_MS)).catch(() => []),
    intelCoins().catch(() => []),
  ]);
  return backfillCoins(branches.map((b) => b.config), undefined, recent, intel);
}

export type LabLease = {
  acquire: (holder: string, ttlMs: number) => Promise<boolean>;
  release: (holder: string) => Promise<void>;
};

const dbLabLease: LabLease = {
  acquire: (holder, ttlMs) => db.acquireLease(LAB_SYNC_COIN, LAB_LEASE_SERIES, holder, ttlMs),
  release: (holder) => db.releaseLease(LAB_SYNC_COIN, LAB_LEASE_SERIES, holder),
};

export type LabCollectRun =
  | LabCollectResult
  | { ok: true; busy: true; written: 0; sources: Record<string, never> }
  | (LabCollectResult & { timedOut: true; inFlight: string });

/**
 * Daily Lab history (src/server/lab/collect.ts): a no-op until a series is
 * 20 h stale. One run at a time: a lease (LAB_LEASE_MS) keeps a retried or
 * overlapping trigger from starting a second full backfill; the loser
 * answers `busy`. Its own failure (lease or sync_state unreadable, every API
 * down) is reported, never thrown. Still running at LAB_HARD_STOP_MS, it
 * answers with what has finished (`timedOut`, and the last line logged as
 * `inFlight`); the lease is then released when the run ends, or expires.
 */
export async function runLabCollect(
  collect: typeof collectLab = collectLab,
  now = Date.now(),
  lease: LabLease = dbLabLease,
  hardStopMs = LAB_HARD_STOP_MS,
): Promise<LabCollectRun> {
  const holder = randomUUID();
  const fail = (err: unknown): LabCollectResult => ({ ok: false, error: err instanceof Error ? err.message : String(err), written: 0, sources: {} });
  let held: boolean;
  try {
    held = await lease.acquire(holder, LAB_LEASE_MS);
  } catch (err) {
    return fail(err);
  }
  if (!held) return { ok: true, busy: true, written: 0, sources: {} };
  const progress: LabProgress = { sources: {}, written: 0 };
  let inFlight = "start";
  const log = (line: string) => ((inFlight = line), console.log(line));
  const release = () => lease.release(holder).catch((err) => console.error("[lab-collect] lease release:", err));
  const work = (async () => {
    try {
      return await collect(undefined, { deadline: now + LAB_BUDGET_MS, progress, log }).catch(fail);
    } finally {
      await release();
    }
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hardStop = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), hardStopMs);
  });
  const done = await Promise.race([work, hardStop]);
  clearTimeout(timer);
  if (done) return done;
  console.error(`[lab-collect] hard stop; last: ${inFlight}`);
  const error = `still running after ${Math.round(hardStopMs / 1000)}s; last: ${inFlight}`;
  return { ok: false, error, written: progress.written, sources: { ...progress.sources }, timedOut: true, inFlight };
}

// ── Intel cron jobs (SPEC.md § Intel I2) ──
//
// ingest (sources + mapper + catalyst alerts), brief (cron-surface brief to
// Telegram), graph (seed edges + daily LLM refresh) and watch (doc/contract
// watcher). Each runs under its own lease (sync_state coin '_intel', series =
// job) and the shared 200 s budget; brief and graph also self-throttle on an
// intel_settings timestamp written when a run completes, so the workflow can
// call all four every 15 minutes. "lease held" and "throttled" answer 200.

export const INTEL_BUDGET_MS = 200_000;
export const INTEL_LEASE_MS = INTEL_BUDGET_MS + 60_000;
export const INTEL_HARD_STOP_MS = INTEL_BUDGET_MS + 40_000;
export const INTEL_LEASE_COIN = "_intel";
/** A run due at 6 h on a 15-minute schedule should not slip a whole tick. */
const THROTTLE_SLACK_MS = 5 * 60_000;

export type IntelJob = "ingest" | "brief" | "graph" | "watch";

/** `complete: false` leaves the throttle timestamp alone, so the next call picks up the rest. */
export type IntelJobRun = (o: { budgetMs: number; signal: AbortSignal }) => Promise<{ ok: boolean; complete: boolean; result: unknown }>;

export interface IntelCronDeps {
  lease(job: IntelJob): LabLease;
  settings: Pick<IntelStore, "getSetting" | "setSetting">;
  run: Record<IntelJob, IntelJobRun>;
  env: Record<string, string | undefined>;
  now(): number;
  hardStopMs?: number;
}

export const intelSettingKey = (job: IntelJob) => `cron_${job}_at`;

/** Minimum gap between runs: brief INTEL_BRIEF_HOURS (default 6, 1–168), graph daily, the rest none. */
export function intelThrottleMs(job: IntelJob, env: Record<string, string | undefined>): number {
  if (job === "graph") return DAY_MS;
  if (job !== "brief") return 0;
  const h = Number(env.INTEL_BRIEF_HOURS);
  return (env.INTEL_BRIEF_HOURS?.trim() && Number.isFinite(h) ? Math.min(168, Math.max(1, h)) : 6) * 3_600_000;
}

/** One leased, budgeted Intel job. Never throws; a thrown run or lease error is a 500 body. */
export async function runIntelJob(job: IntelJob, deps: IntelCronDeps): Promise<{ status: 200 | 500; body: Record<string, unknown> }> {
  const holder = randomUUID();
  const lease = deps.lease(job);
  const fail = (err: unknown) => ({ status: 500 as const, body: { job, ok: false, error: err instanceof Error ? err.message : String(err) } });
  try {
    if (!(await lease.acquire(holder, INTEL_LEASE_MS))) return { status: 200, body: { job, ok: true, skipped: "lease held" } };
  } catch (err) {
    return fail(err);
  }
  const release = () => lease.release(holder).catch((err) => console.error(`[intel:${job}] lease release:`, err));
  const started = deps.now();
  const hardStopMs = deps.hardStopMs ?? INTEL_HARD_STOP_MS;
  const abort = new AbortController();
  const work = (async () => {
    try {
      const gap = intelThrottleMs(job, deps.env);
      if (gap) {
        const last = await deps.settings.getSetting<string>(intelSettingKey(job));
        if (last && started - Date.parse(last) < gap - THROTTLE_SLACK_MS) return { status: 200 as const, body: { job, ok: true, skipped: "throttled", lastRunAt: last } };
      }
      const r = await deps.run[job]({ budgetMs: INTEL_BUDGET_MS, signal: abort.signal });
      if (gap && r.complete) await deps.settings.setSetting(intelSettingKey(job), new Date(started).toISOString());
      return { status: r.ok ? (200 as const) : (500 as const), body: { job, ok: r.ok, ms: deps.now() - started, result: r.result } };
    } catch (err) {
      return fail(err);
    } finally {
      await release();
    }
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hardStop = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), hardStopMs);
  });
  const done = await Promise.race([work, hardStop]);
  clearTimeout(timer);
  if (done) return done;
  abort.abort();
  console.error(`[intel:${job}] hard stop after ${Math.round(hardStopMs / 1000)}s`);
  return { status: 500, body: { job, ok: false, timedOut: true, error: `still running after ${Math.round(hardStopMs / 1000)}s` } };
}

export interface ResearchStageResult extends Partial<AutoResearchRun> {
  ran: number;
  /** Not started: not enough budget left. */
  skipped?: true;
  error?: string;
}

/**
 * The ingest job's last stage (SPEC S0.3): automatic research. Never throws and never fails ingest; a run is recorded
 * as collector_runs `intel:research` (ok = no failed research).
 */
export async function researchStage(
  deps: Omit<AutoResearchDeps, "left" | "signal">,
  o: { left(): number; signal?: AbortSignal },
  run: (d: AutoResearchDeps) => Promise<AutoResearchRun> = autoResearch,
  record: typeof db.recordCollectorRun = db.recordCollectorRun,
): Promise<ResearchStageResult> {
  if (o.left() <= RESEARCH_DEADLINE_MS + AUTO_RESEARCH_MARGIN_MS) return { ran: 0, skipped: true };
  const startedAt = new Date();
  let res: ResearchStageResult;
  try {
    res = await run({ ...deps, ...o });
  } catch (e) {
    res = { ran: 0, error: e instanceof Error ? e.message : String(e) };
  }
  await record("intel:research", startedAt, !res.error && !res.statuses?.failed, res.error ?? (res.statuses?.failed ? `${res.statuses.failed} failed` : null)).catch((e) =>
    console.error("[intel:research] collector run not recorded:", e),
  );
  return res;
}

const defaultIntelCronDeps = (): IntelCronDeps => {
  const d = defaultIntelDeps();
  return {
    lease: (job) => ({
      acquire: (holder, ttlMs) => db.acquireLease(INTEL_LEASE_COIN, job, holder, ttlMs),
      release: (holder) => db.releaseLease(INTEL_LEASE_COIN, job, holder),
    }),
    settings: d.store,
    env: d.env ?? process.env,
    now: () => Date.now(),
    run: {
      // Flow detector events (SPEC F0.4) ride on the ingest job, after the mapper; code only, no LLM.
      ingest: async (o) => {
        const t0 = Date.now();
        const left = () => o.budgetMs - (Date.now() - t0);
        const result = await runIntelIngest(d.ingest, o);
        const flowStart = new Date();
        const flows = await flowAlerts(d.ingest, flowStart, { left, signal: o.signal }).then(
          (r) => ({ events: r.events.length, alerts: r.alerts.length, pushed: r.alerts.filter((a) => a.route === "push").length, errors: r.errors }),
          (e) => ({ events: 0, alerts: 0, pushed: 0, errors: [e instanceof Error ? e.message : String(e)] }),
        );
        await db.recordCollectorRun("intel:flow:detect", flowStart, !flows.errors.length, flows.errors.join("; ").slice(0, 500) || null).catch((e) =>
          console.error("[intel:flow] collector run not recorded:", e),
        );
        // Automatic research (SPEC S0.3) is the last stage: it needs this run's flow alerts and more than its own deadline of budget. Never fatal.
        const research = await researchStage(d.ingest, { left, signal: o.signal });
        return { ok: true, complete: true, result: { ...result, flows, research } };
      },
      brief: async (o) => {
        const r = await runIntelBrief({ ...d, notifier: d.notifier, appUrl: d.appUrl }, o);
        return { ok: r.ok, complete: r.ok, result: r };
      },
      graph: async (o) => {
        const r = await refreshGraph(d.graph, o);
        return { ok: true, complete: r.skipped.length === 0 && !r.warning, result: r };
      },
      watch: async (o) => ({ ok: true, complete: true, result: await runIntelWatch(d.docwatch, o) }),
    },
  };
};

export function intelCronRoute(job: IntelJob, deps: () => IntelCronDeps = defaultIntelCronDeps) {
  return async (c: Context) => {
    const { status, body } = await runIntelJob(job, deps());
    return c.json(body, status);
  };
}

// Cron requests in flight in this process. Vercel Cron and the GitHub
// workflow can now overlap on one warm instance.
let activeCronRequests = 0;

// Safe to call repeatedly: observations PK (series_id, ts) dedupes upserts,
// and each collector run is independent — a re-trigger just overwrites the
// same timestamp's values.
// GET is what Vercel Cron sends; POST is what the GitHub workflow sends.
export const cronRoutes = new Hono()
  // Hono's default answer to an uncaught error is a bare "Internal Server
  // Error", which is all the collect workflow could log. Cron routes sit
  // behind the cron token, so the message can go back to the caller.
  .onError((err, c) => {
    console.error(`[cron] ${c.req.path} failed:`, err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  })
  // Never leave a cron run's connection idle in a warm instance: the next run
  // reusing it hung on its first query until the hard stop. Only the last
  // request out releases it, so one run never cuts off another's queries.
  .use("*", async (_c, next) => {
    activeCronRequests++;
    try {
      await next();
    } finally {
      if (--activeCronRequests === 0) await db.releaseConnection();
    }
  })
  .on(["GET", "POST"], "/collect", requireCronToken, async (c) => {
    // A replayed spill from the previous run (POST body `{ replay }`, sent by
    // the collect workflow). Vercel Cron's GET has no body.
    let replay = emptyBatch();
    if (c.req.method === "POST") {
      const text = await c.req.text();
      if (text.trim()) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          return c.json({ error: "body is not JSON" }, 400);
        }
        const r = CollectBatchSchema.safeParse((parsed as { replay?: unknown } | null)?.replay ?? emptyBatch());
        if (!r.success) return c.json({ error: "invalid replay batch", issues: r.error.issues.slice(0, 5) }, 400);
        replay = r.data;
      }
    }
    // Fetch phase: collectors and Intel snapshots write into the sink, not the
    // database. The reads they still need are capped, so a slow database
    // costs seconds here, not the 30 s query timeout.
    const sink = createBatchSink();
    const collectDeadline = Date.now() + COLLECT_BUDGET_MS;
    let snapshots: Promise<SnapshotResult> | undefined;
    let flow: Promise<FlowCollectResult> | undefined;
    const onCtxs = (ctxs: AssetCtx[], ts: Date) => {
      snapshots = runIntelSnapshots(ctxs, ts, collectDeadline, sink);
      flow = snapshots.then(() => runIntelFlow(ctxs, collectDeadline));
    };
    const threw: string[] = [];
    const settle = (name: string, p: Promise<CollectorResult>): Promise<CollectorResult> =>
      p.catch((err) => {
        const error = err instanceof Error ? err.message : String(err);
        console.error(`[collect] ${name} threw:`, err);
        threw.push(name);
        return { ok: false, error: `threw: ${error}`, written: 0 };
      });
    const [hyperliquid, cryptoContext, fred, elfa] = await Promise.all([
      settle("hyperliquid", capped(oiCoins(), COLLECT_READ_MS, []).then((extra) => collectHyperliquid(fetch, sink.db, extra, onCtxs))),
      settle("cryptoContext", collectCryptoContext(fetch, sink.db)),
      settle("fred", collectFred(fetch, sink.db)),
      // Throttle check unreadable: treat Elfa as just fetched, so a slow database never spends a credit.
      settle("elfa", collectElfa(fetch, { ...defaultElfaDeps, ...sink.db, lastFetch: () => capped(defaultElfaDeps.lastFetch(), COLLECT_READ_MS, new Date()) })),
    ]);
    const intelSnapshots = snapshots ? await snapshots : { ok: false, written: 0, error: "no asset contexts (hyperliquid collect failed)" };
    // Write phase: this run's rows over the replayed spill, under one budget.
    const flush = await flushBatch(mergeBatches(replay, sink.batch), collectWriter(), FLUSH_BUDGET_MS);
    const intelFlow = flow ? await flow : { ok: false, written: 0, error: "no asset contexts (hyperliquid collect failed)" };
    const spilled = batchSize(flush.spill);
    const since = flush.spill.since ? Date.parse(flush.spill.since) : null;
    // Rows the database could not take come back for the workflow to cache and replay. A spill is a
    // green run (nothing lost); one first spilled SPILL_ALARM_MS ago means the database has been
    // unwritable that long, and a throw is a bug: both are a failed collect.
    const stale = since != null && Date.now() - since > SPILL_ALARM_MS;
    return c.json(
      {
        hyperliquid, cryptoContext, fred, elfa, intelSnapshots, intelFlow,
        flush: { written: flush.written, replayed: batchSize(replay), spilled, ...(flush.errors.length ? { errors: flush.errors } : {}), ...(flush.spill.since ? { spilledSince: flush.spill.since } : {}) },
        ...(threw.length ? { threw } : {}),
        ...(spilled ? { spill: flush.spill } : {}),
      },
      threw.length || stale ? 500 : 200,
    );
  })
  // Lab history on its own route: a long first backfill must not hold up (or
  // be retried with) the 15-minute collection. Leased: one run at a time.
  .on(["GET", "POST"], "/lab-collect", requireCronToken, async (c) => c.json(await runLabCollect()))
  .on(["GET", "POST"], "/backfill", requireCronToken, backfillRoute())
  .on(["GET", "POST"], "/intel/ingest", requireCronToken, intelCronRoute("ingest"))
  .on(["GET", "POST"], "/intel/brief", requireCronToken, intelCronRoute("brief"))
  .on(["GET", "POST"], "/intel/graph", requireCronToken, intelCronRoute("graph"))
  .on(["GET", "POST"], "/intel/watch", requireCronToken, intelCronRoute("watch"));
