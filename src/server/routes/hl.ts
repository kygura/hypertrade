import { Hono } from "hono";
import { fetchPerpMetaAndCtxs } from "../../shared/hl-client";
import type { AssetCtx } from "../../shared/types";

// GET /hl/markets — live pass-through snapshot of the Hyperliquid universe
// (SPEC.md API surface). Module-level 60s cache: serverless-ephemeral is
// fine here, each cold start just misses once.

const CACHE_MS = 60_000;
let cache: { ts: number; markets: MarketRow[] } | null = null;

export interface MarketRow {
  coin: string;
  markPx: number;
  oraclePx: number;
  premium: number;
  funding: number;
  openInterestUsd: number;
  dayNtlVlm: number;
  dayChangePct: number;
}

export function toMarketRows(ctxs: AssetCtx[]): MarketRow[] {
  return ctxs
    .filter((c) => !c.isDelisted)
    .map((c) => ({
      coin: c.name,
      markPx: c.markPx,
      oraclePx: c.oraclePx,
      premium: c.premium,
      funding: c.funding,
      openInterestUsd: c.openInterest * c.markPx,
      dayNtlVlm: c.dayNtlVlm,
      dayChangePct: c.dayChange,
    }))
    .sort((a, b) => b.openInterestUsd - a.openInterestUsd);
}

export const hlRoutes = new Hono().get("/markets", async (c) => {
  if (cache && Date.now() - cache.ts < CACHE_MS) return c.json(cache.markets);
  const { ctxs } = await fetchPerpMetaAndCtxs();
  const markets = toMarketRows(ctxs);
  cache = { ts: Date.now(), markets };
  return c.json(markets);
});
