import { Hono } from "hono";
import { assetClass, dexOf, type AssetClass } from "../../shared/assetClass.js";
import { fetchPerpDexs, fetchPerpMetaAndCtxs } from "../../shared/hl-client.js";
import type { AssetCtx } from "../../shared/types.js";

// GET /hl/markets — live pass-through snapshot of the Hyperliquid universe
// (docs/SPEC.md API surface). Module-level 60s cache: serverless-ephemeral is
// fine here, each cold start just misses once. `?scope=all` adds every HIP-3
// builder dex (stocks, commodities, indices, FX, rates) on its own cache, so
// the main-dex snapshot the Desk, sim and analyst read stays unchanged.

const CACHE_MS = 60_000;
let cache: { ts: number; ctxs: AssetCtx[]; markets: MarketRow[] } | null = null;
let allCache: { ts: number; ctxs: AssetCtx[]; markets: MarketRow[]; failedDexes: string[] } | null = null;

export interface MarketsResponse {
  fetchedAt: string;
  markets: MarketRow[];
  /** scope=all only: HIP-3 dexes whose snapshot failed and are missing from `markets`. */
  failedDexes?: string[];
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
  /** "" for the main dex, else the HIP-3 dex prefix ("xyz"). */
  dex: string;
  assetClass: AssetClass;
  maxLeverage: number | null;
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
      dex: dexOf(c.name),
      assetClass: assetClass(c.name),
      maxLeverage: c.maxLeverage ?? null,
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

async function refreshAll() {
  const main = await refresh();
  if (!allCache || Date.now() - allCache.ts >= CACHE_MS) {
    const dexes = await fetchPerpDexs();
    // One broken builder dex must not blank the board: keep the rest, name the gap.
    const settled = await Promise.allSettled(dexes.map((d) => fetchPerpMetaAndCtxs(fetch, d.name)));
    const failedDexes = dexes.filter((_, i) => settled[i]!.status === "rejected").map((d) => d.name);
    const hip3 = settled.flatMap((r) => (r.status === "fulfilled" ? r.value.ctxs : []));
    const ctxs = [...main.ctxs, ...hip3];
    allCache = { ts: Date.now(), ctxs, markets: toMarketRows(ctxs), failedDexes };
  }
  return allCache;
}

/** Cached asset contexts across the main dex and every HIP-3 dex. */
export async function getAllCtxs(): Promise<{ fetchedAt: number; ctxs: AssetCtx[] }> {
  const c = await refreshAll();
  return { fetchedAt: c.ts, ctxs: c.ctxs };
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
    const { ctxs } = await (param.includes(":") ? getAllCtxs() : getCtxs());
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
  // response time — Markets/MarketDrill (docs/design/README.md §10.7) stale-check off
  // this, not client poll time.
  return { fetchedAt: new Date(c.ts).toISOString(), markets: c.markets };
}

/** Cached snapshot across the main dex and every HIP-3 dex. */
export async function getAllMarkets(): Promise<MarketsResponse> {
  const c = await refreshAll();
  return { fetchedAt: new Date(c.ts).toISOString(), markets: c.markets, failedDexes: c.failedDexes };
}

export const hlRoutes = new Hono().get("/markets", async (c) => {
  return c.json(c.req.query("scope") === "all" ? await getAllMarkets() : await getMarkets());
});
