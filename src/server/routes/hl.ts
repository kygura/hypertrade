import { Hono } from "hono";
import { fetchPerpMetaAndCtxs } from "../../shared/hl-client";
import type { AssetCtx } from "../../shared/types";

// GET /hl/markets — live pass-through snapshot of the Hyperliquid universe
// (SPEC.md API surface). Module-level 60s cache: serverless-ephemeral is
// fine here, each cold start just misses once.

const CACHE_MS = 60_000;
let cache: { ts: number; markets: MarketRow[] } | null = null;

export interface MarketsResponse {
  fetchedAt: string;
  markets: MarketRow[];
}

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

/** Cached Hyperliquid universe snapshot (shared by the route and the analyst tools). */
export async function getMarkets(): Promise<MarketsResponse> {
  if (!cache || Date.now() - cache.ts >= CACHE_MS) {
    const { ctxs } = await fetchPerpMetaAndCtxs();
    cache = { ts: Date.now(), markets: toMarketRows(ctxs) };
  }
  // fetchedAt = when the cached snapshot was actually fetched upstream, not
  // response time — Markets/MarketDrill (DESIGN.md §10.7) stale-check off
  // this, not client poll time.
  return { fetchedAt: new Date(cache.ts).toISOString(), markets: cache.markets };
}

export const hlRoutes = new Hono().get("/markets", async (c) => {
  return c.json(await getMarkets());
});
