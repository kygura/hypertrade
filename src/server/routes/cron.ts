import { Hono, type Context } from "hono";
import { requireCronToken } from "../auth.js";
import { collectCryptoContext } from "../collectors/cryptoContext.js";
import { collectFred } from "../collectors/fred.js";
import { collectHyperliquid } from "../collectors/hyperliquid.js";
import * as db from "../db.js";
import { backfillCoin } from "../sim/backfill.js";

const DAY_MS = 86400000;
const DEFAULT_BACKFILL_DAYS = 365;
/** Always kept warm, so charts have history before anyone opens them. */
export const CORE_COINS = ["BTC", "ETH", "SOL", "HYPE"];

export type BackfillDeps = {
  listBranches: () => Promise<{ config: unknown }[]>;
  backfillCoin: (coin: string, startDate: Date) => Promise<void>;
  candleCoverage: (coin: string, tf: string) => Promise<{ min: Date; max: Date } | null>;
};
const defaultBackfillDeps: BackfillDeps = {
  listBranches: db.listBranches,
  backfillCoin: (coin, startDate) => backfillCoin(coin, startDate),
  candleCoverage: db.candleCoverage,
};

/** Core coins plus every coin a saved branch allocates to, uppercased and deduped. */
export function backfillCoins(branchConfigs: unknown[], requested?: string): string[] {
  if (requested) return [...new Set(requested.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean))];
  const coins = new Set(CORE_COINS);
  for (const config of branchConfigs) {
    const allocations = (config as { allocations?: { coin?: unknown }[] } | null)?.allocations ?? [];
    for (const a of allocations) if (typeof a.coin === "string") coins.add(a.coin.toUpperCase());
  }
  return [...coins];
}

/**
 * Daily-candle backfill without a browser session: the chart and simulator
 * routes only backfill when someone is logged in and asks, so history never
 * existed until a person opened a page. Idempotent — covered coins are a
 * coverage query and nothing more — and sequential, to stay inside
 * CoinGecko's free-tier rate limit. One coin failing does not stop the rest.
 */
export function backfillRoute(deps: BackfillDeps = defaultBackfillDeps) {
  return async (c: Context) => {
    const days = Number(c.req.query("days") ?? DEFAULT_BACKFILL_DAYS);
    if (!Number.isFinite(days) || days < 1 || days > 3650) return c.json({ error: "days must be 1-3650" }, 400);
    const startDate = new Date(Date.now() - days * DAY_MS);
    const branches = c.req.query("coins") ? [] : await deps.listBranches();
    const coins = backfillCoins(branches.map((b) => b.config), c.req.query("coins"));

    const results: Record<string, { ok: boolean; from?: string; to?: string; error?: string }> = {};
    for (const coin of coins) {
      try {
        await deps.backfillCoin(coin, startDate);
        const coverage = await deps.candleCoverage(coin, "1d");
        results[coin] = coverage
          ? { ok: true, from: coverage.min.toISOString(), to: coverage.max.toISOString() }
          : { ok: true };
      } catch (err) {
        results[coin] = { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
    return c.json({ days, results });
  };
}

// Safe to call repeatedly: observations PK (series_id, ts) dedupes upserts,
// and each collector run is independent — a re-trigger just overwrites the
// same timestamp's values.
export const cronRoutes = new Hono()
  .post("/collect", requireCronToken, async (c) => {
    const [hyperliquid, cryptoContext, fred] = await Promise.all([
      collectHyperliquid(),
      collectCryptoContext(),
      collectFred(),
    ]);
    return c.json({ hyperliquid, cryptoContext, fred });
  })
  .post("/backfill", requireCronToken, backfillRoute());
