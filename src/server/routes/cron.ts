import { Hono, type Context } from "hono";
import { hlWeightWaitMs } from "../../shared/hl-client.js";
import { TF_RETENTION_MS, TIMEFRAMES, type Timeframe } from "../../shared/timeframes.js";
import { requireCronToken } from "../auth.js";
import { collectCryptoContext } from "../collectors/cryptoContext.js";
import { collectFred } from "../collectors/fred.js";
import { collectHyperliquid } from "../collectors/hyperliquid.js";
import * as db from "../db.js";
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
const FUNDING_PAGES_PER_RUN = 20;

export type WarmResult = { from?: string; to?: string; tfs: number; fundingFrom?: string | null };

export type BackfillDeps = {
  listBranches: () => Promise<{ config: unknown }[]>;
  recentCoins: () => Promise<string[]>;
  /** Daily history to startDate, head sync of every timeframe, funding pages. */
  warmCoin: (coin: string, startDate: Date, deadline: number) => Promise<WarmResult>;
  /** Retention for the finest timeframes; returns rows dropped per timeframe. */
  prune: () => Promise<Record<string, number>>;
  now: () => number;
};

/**
 * Room to start another step: counts the wait HL's weight guard would impose
 * first (up to 60s once a run has spent its per-minute budget), which a plain
 * clock check misses.
 */
const canStart = (deadline: number) => Date.now() + hlWeightWaitMs() < deadline;

export async function warmCoin(coin: string, startDate: Date, deadline: number): Promise<WarmResult> {
  if (canStart(deadline)) await backfillCoin(coin, startDate, undefined, deadline);
  // Head sync every timeframe: HL keeps only the latest 5000 bars, so this is
  // what lets 1m/5m/15m history outlive HL's window.
  let tfs = 0;
  for (const tf of TIMEFRAMES) {
    if (!canStart(deadline)) break;
    await syncHead(coin, tf, undefined, true, deadline);
    tfs++;
  }
  const f = canStart(deadline) ? await syncFunding(coin, 0, { maxPages: FUNDING_PAGES_PER_RUN, deadline }) : null;
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
    const [branches, recent] = requested ? [[], []] : await Promise.all([deps.listBranches(), deps.recentCoins().catch(() => [])]);
    const coins = backfillCoins(branches.map((b) => b.config), requested, recent);

    const results: Record<string, { ok: boolean; skipped?: boolean; error?: string } & Partial<WarmResult>> = {};
    for (const coin of coins) {
      if (deps.now() > deadline) {
        results[coin] = { ok: false, skipped: true };
        continue;
      }
      try {
        results[coin] = { ok: true, ...(await deps.warmCoin(coin, startDate, deadline)) };
      } catch (err) {
        results[coin] = { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
    const pruned = await deps.prune().catch((err) => ({ error: err instanceof Error ? err.message : String(err) }));
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

// Safe to call repeatedly: observations PK (series_id, ts) dedupes upserts,
// and each collector run is independent — a re-trigger just overwrites the
// same timestamp's values.
export const cronRoutes = new Hono()
  .post("/collect", requireCronToken, async (c) => {
    const [hyperliquid, cryptoContext, fred] = await Promise.all([
      oiCoins().then((extra) => collectHyperliquid(fetch, undefined, extra)),
      collectCryptoContext(),
      collectFred(),
    ]);
    return c.json({ hyperliquid, cryptoContext, fred });
  })
  .post("/backfill", requireCronToken, backfillRoute());
