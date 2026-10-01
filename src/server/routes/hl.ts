import { Hono } from "hono";
import { fetchPerpMetaAndCtxs } from "../../shared/hl-client.js";
import type { AssetCtx } from "../../shared/types.js";

// GET /hl/markets — live pass-through snapshot of the Hyperliquid universe
// (SPEC.md API surface). Module-level 60s cache: serverless-ephemeral is
// fine here, each cold start just misses once.

const CACHE_MS = 60_000;
let cache: { ts: number; ctxs: AssetCtx[]; markets: MarketRow[] } | null = null;

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

async function refresh() {
  if (!cache || Date.now() - cache.ts >= CACHE_MS) {
    const { ctxs } = await fetchPerpMetaAndCtxs();
    cache = { ts: Date.now(), ctxs, markets: toMarketRows(ctxs) };
  }
  return cache;
}

/** Cached raw asset contexts (every field, delisted included) and when they were fetched. */
export async function getCtxs(): Promise<{ fetchedAt: number; ctxs: AssetCtx[] }> {
  const c = await refresh();
  return { fetchedAt: c.ts, ctxs: c.ctxs };
}

/**
 * Canonical HL coin name for a URL param. Names are case-sensitive upstream
 * ("kPEPE"), so a case-insensitive match against the universe wins; unknown
 * names (or HL unreachable) fall back to uppercase.
 */
export async function resolveCoin(param: string): Promise<string> {
  try {
    const { ctxs } = await getCtxs();
    const hit = ctxs.find((c) => c.name.toLowerCase() === param.toLowerCase());
    if (hit) return hit.name;
  } catch {
    // HL unreachable: best effort below
  }
  return param.toUpperCase();
}

/** Cached Hyperliquid universe snapshot (shared by the route and the analyst tools). */
export async function getMarkets(): Promise<MarketsResponse> {
  const c = await refresh();
  // fetchedAt = when the cached snapshot was actually fetched upstream, not
  // response time — Markets/MarketDrill (DESIGN.md §10.7) stale-check off
  // this, not client poll time.
  return { fetchedAt: new Date(c.ts).toISOString(), markets: c.markets };
}

export const hlRoutes = new Hono().get("/markets", async (c) => {
  return c.json(await getMarkets());
});
