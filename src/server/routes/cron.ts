import { randomUUID } from "node:crypto";
import { Hono, type Context } from "hono";
import { hlWeightWaitMs } from "../../shared/hl-client.js";
import { TF_RETENTION_MS, TIMEFRAMES, type Timeframe } from "../../shared/timeframes.js";
import { requireCronToken } from "../auth.js";
import { collectCryptoContext } from "../collectors/cryptoContext.js";
import { collectElfa } from "../collectors/elfa.js";
import { collectFred } from "../collectors/fred.js";
import { collectHyperliquid } from "../collectors/hyperliquid.js";
import * as db from "../db.js";
import { collectLab, LAB_SYNC_COIN, type LabCollectResult, type LabProgress } from "../lab/collect.js";
import { syncHead } from "../market/candleSync.js";
import { syncFunding } from "../market/fundingSync.js";
import { backfillCoin, STABLES } from "../sim/backfill.js";

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

const defaultBackfillDeps: BackfillDeps = {
  listBranches: db.listBranches,
  recentCoins: () => db.recentlyAccessedCoins(new Date(Date.now() - RECENT_MS)),
  warmCoin,
  prune: () => pruneRetention(),
  now: () => Date.now(),
};

/** Core coins, then every coin a saved branch allocates to, then recently charted coins. Deduped, stables dropped. */
export function backfillCoins(branchConfigs: unknown[], requested?: string, recent: string[] = []): string[] {
  if (requested) return [...new Set(requested.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean))];
  const coins = new Set(CORE_COINS);
  for (const config of branchConfigs) {
    const allocations = (config as { allocations?: { coin?: unknown }[] } | null)?.allocations ?? [];
    for (const a of allocations) if (typeof a.coin === "string") coins.add(a.coin.toUpperCase());
  }
  for (const c of recent) coins.add(c);
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
      const [branches, recent] = requested
        ? [[], []]
        : await Promise.all([deps.listBranches(), deps.recentCoins().catch(() => [])]);
      coins = backfillCoins(branches.map((b) => b.config), requested, recent);
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
  const [branches, recent] = await Promise.all([
    db.listBranches().catch(() => []),
    db.recentlyAccessedCoins(new Date(Date.now() - RECENT_MS)).catch(() => []),
  ]);
  return backfillCoins(branches.map((b) => b.config), undefined, recent);
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

// Cron requests in flight in this process. Vercel Cron and the GitHub
// workflow can now overlap on one warm instance.
let activeCronRequests = 0;

// Safe to call repeatedly: observations PK (series_id, ts) dedupes upserts,
// and each collector run is independent — a re-trigger just overwrites the
// same timestamp's values.
// GET is what Vercel Cron sends; POST is what the GitHub workflow sends.
export const cronRoutes = new Hono()
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
    const [hyperliquid, cryptoContext, fred, elfa] = await Promise.all([
      oiCoins().then((extra) => collectHyperliquid(fetch, undefined, extra)),
      collectCryptoContext(),
      collectFred(),
      collectElfa(),
    ]);
    return c.json({ hyperliquid, cryptoContext, fred, elfa });
  })
  // Lab history on its own route: a long first backfill must not hold up (or
  // be retried with) the 15-minute collection. Leased: one run at a time.
  .on(["GET", "POST"], "/lab-collect", requireCronToken, async (c) => c.json(await runLabCollect()))
  .on(["GET", "POST"], "/backfill", requireCronToken, backfillRoute());
