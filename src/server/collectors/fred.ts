// FRED (Federal Reserve Economic Data) collector, ported from marketstate/src/fred.ts.
// Series naming per docs/SPEC.md: fred.<SERIES_ID>, plus derived fred.net_liquidity
// and fred.spread_2s10s. Keyless: it reads FRED's public fredgraph CSV through
// radar/macro.ts fetchFred (the keyed API answered 400 without FRED_API_KEY, which
// prod never had, so every fred.* series stayed empty). The CSV carries history, so
// the first run backfills FRED_HISTORY_DAYS and later runs re-read a short window,
// at most once per FRED_MIN_INTERVAL_HOURS (FRED publishes once a day).
import { lastCollectorFetch, ensureSeries, recordCollectorRun, upsertObservations, type Observation, type SeriesDef } from "../db.js";
import { mapLimit } from "../lab/util.js";
import { errDetail, fetchFred, type Point } from "../radar/macro.js";
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
const SKIPPED_THROTTLED = "skipped:throttled";

/** First run, or a gap longer than FRED_BACKFILL_AFTER_DAYS: enough for the desk's 3-month change and a year of Lab history. */
export const FRED_HISTORY_DAYS = 400;
/** Later runs: a short window that also picks up FRED's revisions and anything a missed run skipped. */
export const FRED_RECENT_DAYS = 14;
export const FRED_BACKFILL_AFTER_DAYS = 7;
export const FRED_MIN_INTERVAL_HOURS = 6;
const FRED_CONCURRENCY = 6;
const DAY_MS = 86_400_000;

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

/**
 * deriveMetrics on every date the inputs share: net liquidity on each WALCL Wednesday (WTREGEN on that date,
 * RRP on or before it), the 2s10s spread on each date with both yields. One formula, history included.
 */
export function deriveHistory(points: Partial<Record<FredSeriesId, Point[]>>): Record<string, Point[]> {
  const onOrBefore = (xs: Point[] | undefined, date: string) => {
    let hit: Point | undefined;
    for (const p of xs ?? []) if (p.date <= date && (!hit || p.date > hit.date)) hit = p;
    return hit;
  };
  const net: Point[] = [];
  for (const w of points.WALCL ?? []) {
    const tga = (points.WTREGEN ?? []).find((p) => p.date === w.date);
    const rrp = onOrBefore(points.RRPONTSYD, w.date);
    const d = tga && rrp ? deriveMetrics({ WALCL: w, WTREGEN: tga, RRPONTSYD: rrp }).net_liquidity : undefined;
    if (d) net.push(d);
  }
  const dgs2 = new Map((points.DGS2 ?? []).map((p) => [p.date, p]));
  const spread: Point[] = [];
  for (const p10 of points.DGS10 ?? []) {
    const p2 = dgs2.get(p10.date);
    const d = p2 ? deriveMetrics({ DGS2: p2, DGS10: p10 }).spread_2s10s : undefined;
    if (d) spread.push(d);
  }
  return { net_liquidity: net, spread_2s10s: spread };
}

/** db.ts calls, injectable so tests never need a live DATABASE_URL. `lastFetch` is the latest real (non-skipped) run. */
export type FredDbDeps = {
  ensureSeries: typeof ensureSeries;
  upsertObservations: typeof upsertObservations;
  recordCollectorRun: typeof recordCollectorRun;
  lastFetch: () => Promise<Date | null>;
  now: () => number;
};
export const defaultFredDeps: FredDbDeps = { ensureSeries, upsertObservations, recordCollectorRun, lastFetch: () => lastCollectorFetch(COLLECTOR), now: () => Date.now() };

export async function collectFred(fetchFn: typeof fetch = fetch, deps: FredDbDeps = defaultFredDeps): Promise<CollectorResult> {
  const now = new Date(deps.now());
  // Not recorded: a throttled skip on every collect would bury the real runs.
  const last = await deps.lastFetch();
  const since = last ? now.getTime() - last.getTime() : Infinity;
  if (since < FRED_MIN_INTERVAL_HOURS * 3_600_000) return { ok: true, error: SKIPPED_THROTTLED, written: 0 };
  const days = since > FRED_BACKFILL_AFTER_DAYS * DAY_MS ? FRED_HISTORY_DAYS : FRED_RECENT_DAYS;

  // Per-series catch: one bad series must not discard the other eleven
  // (docs/SPEC.md: never fail the whole run over one tool).
  let firstError: string | undefined;
  const entries = await mapLimit([...FRED_SERIES], FRED_CONCURRENCY, async (id) => {
    try {
      return [id, await fetchFred(fetchFn, id, now, days)] as const;
    } catch (err) {
      firstError ??= `FRED ${id}: ${errDetail(err)}`;
      return [id, null] as const;
    }
  });

  const points: Partial<Record<FredSeriesId, Point[]>> = {};
  for (const [id, pts] of entries) if (pts?.length) points[id] = pts;

  if (Object.keys(points).length === 0) {
    const error = firstError ?? "all series failed";
    await deps.recordCollectorRun(COLLECTOR, now, false, error);
    return { ok: false, error, written: 0 };
  }

  const all: Record<string, Point[]> = { ...points, ...deriveHistory(points) };
  const ids = Object.keys(all).filter((id) => all[id]!.length);
  const seriesDefs: SeriesDef[] = ids.map((id) => ({ id: `fred.${id}`, source: COLLECTOR, description: `FRED series ${id}` }));
  const observations: Observation[] = ids.flatMap((id) => all[id]!.map((p) => ({ seriesId: `fred.${id}`, ts: new Date(p.date), value: p.value })));

  await deps.ensureSeries(seriesDefs);
  const written = await deps.upsertObservations(observations);
  await deps.recordCollectorRun(COLLECTOR, now, true, firstError ?? null);
  return { ok: true, error: firstError, written };
}
