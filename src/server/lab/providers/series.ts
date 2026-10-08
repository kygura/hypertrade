import { DAY_MS, type DailySeries, type LabProvider, type MetricDef } from "../types.js";

// Shared helpers for lab providers: daily bucketing, range clipping, and one
// JSON GET that turns a non-2xx into an error carrying the status.

export type Agg = "last" | "sum" | "mean";

/** UTC midnight of the day containing t. */
export const dayStart = (t: number): number => Math.floor(t / DAY_MS) * DAY_MS;

/** YYYY-MM-DD of a UTC ms timestamp. */
export const isoDay = (t: number): string => new Date(t).toISOString().slice(0, 10);

/** Buckets points into UTC days: ascending, unique, finite values only. `last` keeps the latest point by time. */
export function toDaily(points: Array<{ t: number; v: number }>, agg: Agg): DailySeries {
  const buckets = new Map<number, { last: number; lastT: number; sum: number; n: number }>();
  for (const p of points) {
    if (!Number.isFinite(p.t) || !Number.isFinite(p.v)) continue;
    const d = dayStart(p.t);
    const b = buckets.get(d);
    if (!b) buckets.set(d, { last: p.v, lastT: p.t, sum: p.v, n: 1 });
    else {
      if (p.t >= b.lastT) {
        b.last = p.v;
        b.lastT = p.t;
      }
      b.sum += p.v;
      b.n += 1;
    }
  }
  const days = [...buckets.keys()].sort((a, b) => a - b);
  const v = days.map((d) => {
    const b = buckets.get(d)!;
    return agg === "last" ? b.last : agg === "sum" ? b.sum : b.sum / b.n;
  });
  return { t: days, v };
}

/** Points with fromMs <= t <= toMs (both snapped to their UTC day). */
export function clip(series: DailySeries, fromMs: number, toMs: number): DailySeries {
  const lo = dayStart(fromMs);
  const hi = dayStart(toMs);
  const t: number[] = [];
  const v: number[] = [];
  for (let i = 0; i < series.t.length; i++) {
    const ti = series.t[i]!;
    if (ti >= lo && ti <= hi) {
      t.push(ti);
      v.push(series.v[i]!);
    }
  }
  return { t, v };
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Default per-request timeout. */
export const REQUEST_TIMEOUT_MS = 20_000;

/** A request's timeout: REQUEST_TIMEOUT_MS, capped to what is left before `deadline` (at least 1 ms). */
export const requestTimeout = (deadline: number | undefined, nowMs: number): number =>
  deadline === undefined ? REQUEST_TIMEOUT_MS : Math.max(1, Math.min(REQUEST_TIMEOUT_MS, deadline - nowMs));

/** GET JSON with a timeout. Non-2xx throws HttpError(`<label>: HTTP <status>`). */
export async function getJson(url: string, fetchFn: typeof fetch, label: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
  const res = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new HttpError(`${label}: HTTP ${res.status}`, res.status);
  return res.json();
}

/** Registry hints a provider's catalogue may carry beyond MetricDef. */
export type LabMetricDef = MetricDef & {
  /** Days a value may be forward-filled on the calendar; default 3 (weekly series: 8). */
  maxFillDays?: number;
};

export type HistoryOptions = {
  /**
   * The collector's budget (epoch ms): requests are cut to end by it, and a
   * paged history stops paging there and returns what it has as `partial`.
   */
  deadline?: number;
};

/** A history; `partial` when the deadline cut paging short (ascending, so it is a prefix). */
export type HistorySeries = DailySeries & { partial?: boolean };

/**
 * A provider whose history the cron collector stores (src/server/lab/collect.ts)
 * under `labSeriesId`. `history` is the live source: everything since sinceMs
 * (null = the source's full history) up to now.
 */
export type CollectableProvider = LabProvider & {
  history?(key: string, asset: string, sinceMs: number | null, opts?: HistoryOptions): Promise<HistorySeries>;
};

export const isCollectable = (p: LabProvider): p is LabProvider & Required<Pick<CollectableProvider, "history">> =>
  typeof (p as CollectableProvider).history === "function";

/**
 * Observation series a collected metric is stored under: `lab.<provider>.<key>[.<asset>]`.
 * Its own namespace, apart from the cryptoContext collector's intraday snapshots.
 */
export const labSeriesId = (def: Pick<MetricDef, "provider" | "key" | "scope">, asset: string): string =>
  `lab.${def.provider}.${def.key}${def.scope === "asset" ? `.${asset.toLowerCase()}` : ""}`;
