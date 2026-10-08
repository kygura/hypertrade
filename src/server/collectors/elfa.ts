// Elfa social-attention collector: mention counts from Elfa's trending-tokens
// feed, for coins listed on Hyperliquid. Gives Sector Intelligence a measured
// attention number to set beside the routine's judged mindshare_score.
//
// Elfa counts mentions; it does not predict anything, and no published work
// shows its counts lead price. These series describe attention, nothing more.
//
// Keyed, on a free quota (1,000 credits/month, one credit per call), so it
// throttles itself: the collect cron fires every 15 minutes, this fetches
// once per ELFA_MIN_INTERVAL_HOURS (default 8h, ~90 credits/month). The key is
// meant to be shared with the provenance repo, which spends most of the rest.
// Degrades to skipped:no-key like fred.ts when ELFA_API_KEY is unset.
import { z } from "zod";
import { fetchPerpMetaAndCtxs } from "../../shared/hl-client.js";
import { ensureSeries, lastCollectorFetch, recordCollectorRun, upsertObservations, type Observation, type SeriesDef } from "../db.js";
import type { CollectorResult } from "./types.js";

const COLLECTOR = "elfa";
const SKIPPED_NO_KEY = "skipped:no-key";
const SKIPPED_THROTTLED = "skipped:throttled";
export const ELFA_BASE_URL = "https://api.elfa.ai";
export const DEFAULT_INTERVAL_HOURS = 8;
/** A cron run this close to the interval still fetches; cron timing drifts by minutes. */
const SLACK_MS = 10 * 60_000;
/** Counts are mentions in the trailing 24h, so samples taken hours apart stay comparable. */
const WINDOW = "24h";
const PAGE_SIZE = 50;

// Lenient on purpose: Elfa marks this endpoint experimental and says it adds
// fields without notice. Only the fields used are required.
const TrendingSchema = z.object({
  data: z.object({
    data: z.array(
      z.object({
        token: z.string(),
        current_count: z.number().finite(),
        previous_count: z.number().finite().optional(),
      }),
    ),
  }),
});

export type TrendingRow = { token: string; current: number; previous: number | null };

export function parseElfaTrending(json: unknown): TrendingRow[] {
  return TrendingSchema.parse(json).data.data.map((r) => ({
    token: r.token,
    current: r.current_count,
    previous: r.previous_count ?? null,
  }));
}

/**
 * Elfa reports tickers; Hyperliquid lists some 1000x-denominated memes as
 * kPEPE, kBONK and so on. Returns the HL symbol, or null when the ticker
 * isn't listed (or doesn't look like a ticker at all).
 */
export function hlSymbolFor(token: string, universe: Set<string>): string | null {
  const t = token.trim().replace(/^\$/, "");
  if (!/^[A-Za-z0-9]{1,20}$/.test(t)) return null;
  const upper = t.toUpperCase();
  if (universe.has(upper)) return upper;
  if (universe.has(`k${upper}`)) return `k${upper}`;
  // Already k-prefixed, in any case ("kpepe", "KPEPE").
  const kForm = `k${t.slice(1).toUpperCase()}`;
  if (/^k/i.test(t) && universe.has(kForm)) return kForm;
  return null;
}

/**
 * Pure transform. Share is a coin's mentions over every trending token's
 * mentions in the same response, HL-listed or not, so it reads as "share of
 * crypto-social attention", not "share among perps". Change is computed from
 * the counts rather than taken from Elfa's change_percent, whose unit is not
 * documented; it is a fraction, like every other change in this app.
 */
export function buildElfaObservations(rows: TrendingRow[], universe: Set<string>, ts: Date) {
  const total = rows.reduce((sum, r) => sum + Math.max(0, r.current), 0);
  const byCoin = new Map<string, { current: number; previous: number | null }>();
  for (const r of rows) {
    const coin = hlSymbolFor(r.token, universe);
    if (!coin) continue;
    // Two tickers can land on one coin (PEPE and kPEPE); a missing prior count
    // on either makes the combined change unknowable.
    const prior = byCoin.get(coin);
    const previous = r.previous === null || prior?.previous === null ? null : (prior?.previous ?? 0) + r.previous;
    byCoin.set(coin, { current: (prior?.current ?? 0) + r.current, previous });
  }

  const seriesDefs: SeriesDef[] = [
    { id: "elfa.mentions_24h_total", source: COLLECTOR, units: "mentions", description: "Mentions across Elfa's trending tokens, trailing 24h" },
  ];
  const observations: Observation[] = [{ seriesId: "elfa.mentions_24h_total", ts, value: total }];
  for (const [coin, c] of byCoin) {
    seriesDefs.push(
      { id: `elfa.mentions_24h.${coin}`, source: COLLECTOR, units: "mentions", description: `${coin} social mentions, trailing 24h (Elfa)` },
      { id: `elfa.share_24h.${coin}`, source: COLLECTOR, units: "fraction", description: `${coin} share of trending-token mentions, trailing 24h (Elfa)` },
    );
    observations.push(
      { seriesId: `elfa.mentions_24h.${coin}`, ts, value: c.current },
      { seriesId: `elfa.share_24h.${coin}`, ts, value: total > 0 ? c.current / total : 0 },
    );
    if (c.previous !== null && c.previous > 0) {
      seriesDefs.push({ id: `elfa.mentions_chg_24h.${coin}`, source: COLLECTOR, units: "fraction", description: `${coin} mentions vs the prior 24h (Elfa)` });
      observations.push({ seriesId: `elfa.mentions_chg_24h.${coin}`, ts, value: (c.current - c.previous) / c.previous });
    }
  }
  return { seriesDefs, observations, matched: byCoin.size, rows: rows.length };
}

export type ElfaDeps = {
  ensureSeries: typeof ensureSeries;
  upsertObservations: typeof upsertObservations;
  recordCollectorRun: typeof recordCollectorRun;
  lastFetch: () => Promise<Date | null>;
  /** Live, non-delisted HL perp symbols. */
  universe: (fetchFn: typeof fetch) => Promise<string[]>;
  now: () => number;
};

const defaultDeps: ElfaDeps = {
  ensureSeries,
  upsertObservations,
  recordCollectorRun,
  lastFetch: () => lastCollectorFetch(COLLECTOR),
  universe: async (fetchFn) => (await fetchPerpMetaAndCtxs(fetchFn)).ctxs.filter((c) => !c.isDelisted).map((c) => c.name),
  now: () => Date.now(),
};

export function intervalHours(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.ELFA_MIN_INTERVAL_HOURS);
  return env.ELFA_MIN_INTERVAL_HOURS?.trim() && Number.isFinite(n) && n >= 0 ? n : DEFAULT_INTERVAL_HOURS;
}

export async function collectElfa(
  fetchFn: typeof fetch = fetch,
  deps: ElfaDeps = defaultDeps,
  env: Record<string, string | undefined> = process.env,
): Promise<CollectorResult> {
  const startedAt = new Date(deps.now());
  const apiKey = env.ELFA_API_KEY?.trim();
  if (!apiKey) {
    await deps.recordCollectorRun(COLLECTOR, startedAt, true, SKIPPED_NO_KEY);
    return { ok: true, error: SKIPPED_NO_KEY, written: 0 };
  }

  // Not recorded: a throttled skip every 15 minutes would bury the real runs.
  const last = await deps.lastFetch();
  if (last && deps.now() - last.getTime() < intervalHours(env) * 3_600_000 - SLACK_MS) {
    return { ok: true, error: SKIPPED_THROTTLED, written: 0 };
  }

  try {
    // Universe first: it's free, and without it nothing could be matched, so
    // a dead HL endpoint must not cost an Elfa credit.
    const universe = new Set(await deps.universe(fetchFn));
    const url = `${ELFA_BASE_URL}/v2/aggregations/trending-tokens?timeWindow=${WINDOW}&pageSize=${PAGE_SIZE}&page=1`;
    const res = await fetchFn(url, { headers: { "x-elfa-api-key": apiKey, accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`elfa trending-tokens HTTP ${res.status}`);
    const built = buildElfaObservations(parseElfaTrending(await res.json()), universe, startedAt);
    await deps.ensureSeries(built.seriesDefs);
    const written = await deps.upsertObservations(built.observations);
    await deps.recordCollectorRun(COLLECTOR, startedAt, true, null);
    return { ok: true, written };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await deps.recordCollectorRun(COLLECTOR, startedAt, false, error);
    return { ok: false, error, written: 0 };
  }
}
