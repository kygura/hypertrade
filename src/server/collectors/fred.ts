// FRED (Federal Reserve Economic Data) collector, ported from marketstate/src/fred.ts.
// Series naming per SPEC.md: fred.<SERIES_ID>, plus derived fred.net_liquidity
// and fred.spread_2s10s. Degrades to skipped:no-key when FRED_API_KEY unset —
// keep that exact pattern (marketstate's fetcher, and downstream consumers,
// expect a skip to be distinguishable from a real failure).
import { z } from "zod";
import { ensureSeries, recordCollectorRun, upsertObservations, type Observation, type SeriesDef } from "../db.js";
import type { CollectorResult } from "./types.js";

export const FRED_SERIES = [
  "WALCL",
  "RRPONTSYD",
  "WTREGEN",
  "DGS2",
  "DGS10",
  "SOFR",
  "BAMLH0A0HYM2",
  "VIXCLS",
  "DTWEXBGS",
  "T10YIE",
  "DCOILWTICO",
  "DGS3MO",
] as const;

export type FredSeriesId = (typeof FRED_SERIES)[number];
export type FredMetric = { value: number; date: string };

const COLLECTOR = "fred";
const SKIPPED_NO_KEY = "skipped:no-key";

// FRED marks a missing observation with the literal string "." — everything
// else is a numeric string.
const FredResponseSchema = z.object({
  observations: z.array(z.object({ date: z.string(), value: z.string() })),
});

/** Pure transform: raw /series/observations payload -> latest non-"." point. Exported for fixture tests. */
export function parseFredObservations(json: unknown): FredMetric | null {
  const parsed = FredResponseSchema.parse(json);
  const latestValid = parsed.observations.find((o) => o.value !== ".");
  if (!latestValid) return null;
  return { value: Number(latestValid.value), date: latestValid.date };
}

/**
 * Derived metrics. Unit normalization (marketstate/src/fred.ts):
 *   WALCL/WTREGEN are Millions of Dollars, RRPONTSYD is Billions — normalize
 *   to billions before combining. DGS2/DGS10 are already percentage points.
 */
export function deriveMetrics(metrics: Partial<Record<FredSeriesId, FredMetric>>): Record<string, FredMetric> {
  const derived: Record<string, FredMetric> = {};
  const { WALCL: walcl, RRPONTSYD: rrp, WTREGEN: tga, DGS2: dgs2, DGS10: dgs10 } = metrics;
  if (walcl && rrp && tga) {
    derived.net_liquidity = { value: walcl.value / 1000 - rrp.value - tga.value / 1000, date: walcl.date };
  }
  if (dgs2 && dgs10) {
    derived.spread_2s10s = { value: dgs10.value - dgs2.value, date: dgs10.date };
  }
  return derived;
}

const OBS_LIMIT = 5;

async function fetchSeries(seriesId: FredSeriesId, apiKey: string, fetchFn: typeof fetch): Promise<FredMetric | null> {
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&api_key=${apiKey}&file_type=json&sort_order=desc&limit=${OBS_LIMIT}`;
  const res = await fetchFn(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`FRED ${seriesId} HTTP ${res.status}`);
  return parseFredObservations(await res.json());
}

/** db.ts calls, injectable so tests never need a live DATABASE_URL. */
export type FredDbDeps = { ensureSeries: typeof ensureSeries; upsertObservations: typeof upsertObservations; recordCollectorRun: typeof recordCollectorRun };
const defaultDeps: FredDbDeps = { ensureSeries, upsertObservations, recordCollectorRun };

export async function collectFred(fetchFn: typeof fetch = fetch, deps: FredDbDeps = defaultDeps): Promise<CollectorResult> {
  const startedAt = new Date();
  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) {
    await deps.recordCollectorRun(COLLECTOR, startedAt, true, SKIPPED_NO_KEY);
    return { ok: true, error: SKIPPED_NO_KEY, written: 0 };
  }

  // Per-series catch: one bad/rate-limited series must not discard the other
  // eleven (SPEC.md: never fail the whole run over one tool).
  let firstError: string | undefined;
  const entries = await Promise.all(
    FRED_SERIES.map(async (id) => {
      try {
        return [id, await fetchSeries(id, apiKey, fetchFn)] as const;
      } catch (err) {
        firstError ??= err instanceof Error ? err.message : String(err);
        return [id, null] as const;
      }
    }),
  );

  const metrics: Partial<Record<FredSeriesId, FredMetric>> = {};
  for (const [id, value] of entries) if (value) metrics[id] = value;

  if (Object.keys(metrics).length === 0) {
    const error = firstError ?? "all series failed";
    await deps.recordCollectorRun(COLLECTOR, startedAt, false, error);
    return { ok: false, error, written: 0 };
  }

  const all: Record<string, FredMetric> = { ...metrics, ...deriveMetrics(metrics) };

  const seriesDefs: SeriesDef[] = Object.keys(all).map((id) => ({
    id: `fred.${id}`,
    source: COLLECTOR,
    description: `FRED series ${id}`,
  }));
  const observations: Observation[] = Object.entries(all).map(([id, m]) => ({
    seriesId: `fred.${id}`,
    ts: new Date(m.date),
    value: m.value,
  }));

  await deps.ensureSeries(seriesDefs);
  const written = await deps.upsertObservations(observations);
  await deps.recordCollectorRun(COLLECTOR, startedAt, true, firstError ?? null);
  return { ok: true, error: firstError, written };
}
