import { Hono } from "hono";
import { SectorsDataSchema } from "../../shared/schemas";
import { fetchPerpMetaAndCtxs } from "../../shared/hl-client";
import type { AssetCtx } from "../../shared/types";
import latest from "../../../data/sectors/latest.json";

const CACHE_MS = 60_000;
let cache: { ts: number; ctxs: AssetCtx[] } | null = null;

async function getCtxs(): Promise<AssetCtx[]> {
  if (cache && Date.now() - cache.ts < CACHE_MS) return cache.ctxs;
  const { ctxs } = await fetchPerpMetaAndCtxs();
  cache = { ts: Date.now(), ctxs };
  return ctxs;
}

export interface SectorTokenRow {
  coin: string;
  markPx: number;
  dayChangePct: number;
  openInterestUsd: number;
  funding: number;
}

/**
 * Per-sector OI/funding aggregate over its constituent tokens, plus a
 * per-matched-token row (DESIGN.md §10.5 drill-in table). Tokens not listed
 * on Hyperliquid (or not found in the current universe) are skipped
 * silently — the sector still renders, just without that token's weight.
 */
export function enrichSector(tokens: string[], ctxs: AssetCtx[]) {
  const matched = tokens
    .map((symbol) => ctxs.find((c) => c.name === symbol))
    .filter((c): c is AssetCtx => c != null);
  const oi_usd_total = matched.reduce((sum, c) => sum + c.openInterest * c.markPx, 0);
  const avg_funding = matched.length
    ? matched.reduce((sum, c) => sum + c.funding, 0) / matched.length
    : 0;
  const tokenRows: SectorTokenRow[] = matched.map((c) => ({
    coin: c.name,
    markPx: c.markPx,
    dayChangePct: c.dayChange,
    openInterestUsd: c.openInterest * c.markPx,
    funding: c.funding,
  }));
  return { oi_usd_total, avg_funding, names_matched: matched.length, tokenRows };
}

export const sectorsRoutes = new Hono().get("/", async (c) => {
  const data = SectorsDataSchema.parse(latest);
  let ctxs: AssetCtx[] = [];
  try {
    ctxs = await getCtxs();
  } catch {
    // Hyperliquid unreachable: still serve the routine's sector read, just
    // without live enrichment, rather than 500ing the whole route.
  }
  const sectors = data.sectors.map((s) => ({ ...s, ...enrichSector(s.tokens, ctxs) }));
  return c.json({ ...data, sectors });
});
