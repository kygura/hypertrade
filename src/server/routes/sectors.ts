import { Hono } from "hono";
import { SectorsDataSchema } from "../../shared/schemas.js";
import { fetchPerpMetaAndCtxs } from "../../shared/hl-client.js";
import type { AssetCtx } from "../../shared/types.js";
import latest from "../../../data/sectors/latest.json" with { type: "json" };
import { latestObservations } from "../db.js";

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
  /** Elfa, trailing 24h. Absent when the collector has no recent sample. */
  mentions24h?: number;
  share24h?: number;
  mentionsChg24h?: number;
}

/** One coin's latest Elfa sample (see collectors/elfa.ts). */
export interface TokenSocial {
  mentions24h: number;
  share24h: number;
  mentionsChg24h?: number;
  ts: Date;
}

/**
 * Older samples are dropped rather than shown as current. The collector
 * fetches every 8h by default; 36h tolerates a few missed runs, and a coin
 * that fell off Elfa's trending list stops showing a stale count.
 */
export const SOCIAL_MAX_AGE_MS = 36 * 3_600_000;
const SOCIAL_TIMEOUT_MS = 3_000;

/** Pure: latest observations for elfa.* series -> per-coin social reads. */
export function socialFromObservations(
  rows: { seriesId: string; ts: Date; value: number }[],
  now: number = Date.now(),
): Map<string, TokenSocial> {
  const out = new Map<string, TokenSocial>();
  const fresh = rows.filter((r) => now - new Date(r.ts).getTime() <= SOCIAL_MAX_AGE_MS);
  const pick = (prefix: string) =>
    new Map(fresh.filter((r) => r.seriesId.startsWith(prefix)).map((r) => [r.seriesId.slice(prefix.length), r] as const));
  const mentions = pick("elfa.mentions_24h.");
  const shares = pick("elfa.share_24h.");
  const changes = pick("elfa.mentions_chg_24h.");
  for (const [coin, m] of mentions) {
    const share = shares.get(coin);
    if (!share) continue;
    const social: TokenSocial = { mentions24h: m.value, share24h: share.value, ts: new Date(m.ts) };
    // A change point from an older sample would describe a different window.
    const change = changes.get(coin);
    if (change && new Date(change.ts).getTime() === social.ts.getTime()) social.mentionsChg24h = change.value;
    out.set(coin, social);
  }
  return out;
}

/**
 * Social reads for the given coins. Never throws and never hangs the route:
 * no database, a slow query or an error all mean "no social data", and the
 * sector read still renders from the routine file and HL.
 */
export async function loadSocial(coins: string[]): Promise<Map<string, TokenSocial>> {
  if (coins.length === 0) return new Map();
  const ids = coins.flatMap((c) => [`elfa.mentions_24h.${c}`, `elfa.share_24h.${c}`, `elfa.mentions_chg_24h.${c}`]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const rows = await Promise.race([
      latestObservations(ids),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("social read timed out")), SOCIAL_TIMEOUT_MS);
      }),
    ]);
    return socialFromObservations(rows);
  } catch {
    return new Map();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Per-sector OI/funding aggregate over its constituent tokens, plus a
 * per-matched-token row (DESIGN.md §10.5 drill-in table). Tokens not listed
 * on Hyperliquid (or not found in the current universe) are skipped
 * silently — the sector still renders, just without that token's weight.
 */
export function enrichSector(tokens: string[], ctxs: AssetCtx[], social: Map<string, TokenSocial> = new Map()) {
  const matched = tokens
    .map((symbol) => ctxs.find((c) => c.name === symbol))
    .filter((c): c is AssetCtx => c != null);
  const oi_usd_total = matched.reduce((sum, c) => sum + c.openInterest * c.markPx, 0);
  const avg_funding = matched.length
    ? matched.reduce((sum, c) => sum + c.funding, 0) / matched.length
    : 0;
  const tokenRows: SectorTokenRow[] = matched.map((c) => {
    const row: SectorTokenRow = {
      coin: c.name,
      markPx: c.markPx,
      dayChangePct: c.dayChange,
      openInterestUsd: c.openInterest * c.markPx,
      funding: c.funding,
    };
    const s = social.get(c.name);
    if (s) {
      row.mentions24h = s.mentions24h;
      row.share24h = s.share24h;
      if (s.mentionsChg24h !== undefined) row.mentionsChg24h = s.mentionsChg24h;
    }
    return row;
  });
  // Measured attention beside the routine's judged mindshare_score: summed
  // over the tokens Elfa had a recent sample for, null when it had none.
  const sampled = matched.map((c) => social.get(c.name)).filter((s): s is TokenSocial => s != null);
  const social_mentions_24h = sampled.length ? sampled.reduce((sum, s) => sum + s.mentions24h, 0) : null;
  const social_share_24h = sampled.length ? sampled.reduce((sum, s) => sum + s.share24h, 0) : null;
  const social_as_of = sampled.length
    ? new Date(Math.min(...sampled.map((s) => s.ts.getTime()))).toISOString()
    : null;
  return {
    oi_usd_total,
    avg_funding,
    names_matched: matched.length,
    tokenRows,
    social_mentions_24h,
    social_share_24h,
    social_as_of,
  };
}

export type SectorsDeps = {
  ctxs: () => Promise<AssetCtx[]>;
  social: (coins: string[]) => Promise<Map<string, TokenSocial>>;
};
const defaultSectorsDeps: SectorsDeps = { ctxs: getCtxs, social: loadSocial };

/**
 * The routine's latest sector read joined with live per-token HL aggregates
 * and, when the Elfa collector has run, measured social attention.
 */
export async function getSectorsPayload(deps: SectorsDeps = defaultSectorsDeps) {
  const data = SectorsDataSchema.parse(latest);
  let ctxs: AssetCtx[] = [];
  try {
    ctxs = await deps.ctxs();
  } catch {
    // Hyperliquid unreachable: still serve the routine's sector read, just
    // without live enrichment, rather than 500ing the whole route.
  }
  const coins = [...new Set(data.sectors.flatMap((s) => s.tokens))];
  const social = await deps.social(coins);
  const sectors = data.sectors.map((s) => ({ ...s, ...enrichSector(s.tokens, ctxs, social) }));
  return { ...data, sectors };
}

export const sectorsRoutes = new Hono().get("/", async (c) => {
  return c.json(await getSectorsPayload());
});
