import type { SnapshotMetric } from "../../shared/intel.js";
import { mean, median, stdev } from "./util.js";

// Normalized deltas (SPEC.md § Intel I0.4). Pure. Each metric family has its
// own z so a 3% move on a quiet coin and on a wild one do not read the same:
//   price, oi_usd       z = Δ_h / (σ_1h · √h), Δ = log change, σ_1h from
//                       hourly log changes over the 7-day history, h the
//                       real elapsed hours (no cap), floored at 0.25
//   funding, premium,   level z of the current value vs the 7-day mean/σ
//   basis               (funding is hourly-stepped, so Δ means little)
//   vol24h, depth_*,    log(now / 7d median) over the 7d σ of that same
//   spread_bps          log ratio
// Fewer than MIN_SAMPLES samples → null: the metric is skipped, never zero.
// The caller loads the history (snapshots) and the cold-start series
// (1h candles, observations, funding rows) and passes them in as points.

export type Point = { t: number; v: number };

const HOUR_MS = 3_600_000;
export const WINDOW_MS = 7 * 24 * HOUR_MS;
export const MIN_SAMPLES = 24;
/** Floor on h: a baseline minutes old would otherwise blow a tick of noise up into a large z. */
export const MIN_H = 0.25;

export type MetricFamily = "return" | "level" | "ratio";

export function metricFamily(metric: SnapshotMetric): MetricFamily {
  if (metric === "price" || metric === "oi_usd") return "return";
  if (metric === "funding" || metric === "premium" || metric === "basis") return "level";
  return "ratio";
}

/** Points in the 7 days up to and including `t`, finite values only, ascending. */
export function inWindow(points: Point[], t: number): Point[] {
  return points.filter((p) => p.t <= t && p.t >= t - WINDOW_MS && Number.isFinite(p.v)).sort((a, b) => a.t - b.t);
}

/**
 * Log changes between adjacent clock hours, the last value of each hour
 * standing for it. A gap (a missing hour) breaks the chain rather than
 * passing a multi-hour move off as one hour's.
 */
export function hourlyLogChanges(points: Point[]): number[] {
  const byHour = new Map<number, number>();
  for (const p of [...points].sort((a, b) => a.t - b.t)) if (p.v > 0) byHour.set(Math.floor(p.t / HOUR_MS), p.v);
  const hours = [...byHour.keys()].sort((a, b) => a - b);
  const out: number[] = [];
  for (let i = 1; i < hours.length; i++) {
    if (hours[i]! - hours[i - 1]! === 1) out.push(Math.log(byHour.get(hours[i]!)! / byHour.get(hours[i - 1]!)!));
  }
  return out;
}

/** price, oi_usd: the log change from→to over σ_1h · √h. */
export function returnZ(from: Point, to: Point, history: Point[]): number | null {
  if (!(from.v > 0) || !(to.v > 0)) return null;
  const elapsed = (to.t - from.t) / HOUR_MS;
  if (!(elapsed > 0)) return null;
  // No cap: capping h while keeping the full Δ would inflate z by √(h/24) (SPEC I0.4).
  const h = Math.max(MIN_H, elapsed);
  const changes = hourlyLogChanges(inWindow(history, to.t));
  if (changes.length < MIN_SAMPLES) return null;
  const sigma = stdev(changes);
  if (!(sigma > 0)) return null;
  return Math.log(to.v / from.v) / (sigma * Math.sqrt(h));
}

/** funding, premium, basis: (now − 7d mean) / 7d σ. */
export function levelZ(to: Point, history: Point[]): number | null {
  if (!Number.isFinite(to.v)) return null;
  const xs = inWindow(history, to.t).map((p) => p.v);
  if (xs.length < MIN_SAMPLES) return null;
  const sigma = stdev(xs);
  if (!(sigma > 0)) return null;
  return (to.v - mean(xs)) / sigma;
}

/** vol24h, depth_*, spread_bps: log(now / 7d median) / 7d σ of log(x / 7d median). */
export function ratioZ(to: Point, history: Point[]): number | null {
  if (!(to.v > 0)) return null;
  const xs = inWindow(history, to.t)
    .map((p) => p.v)
    .filter((v) => v > 0);
  if (xs.length < MIN_SAMPLES) return null;
  const med = median(xs);
  const sigma = stdev(xs.map((v) => Math.log(v / med)));
  if (!(sigma > 0)) return null;
  return Math.log(to.v / med) / sigma;
}

/** True when `history` alone gives the metric enough samples (else the caller's cold-start series is used). */
export function hasSamples(metric: SnapshotMetric, history: Point[], t: number): boolean {
  const w = inWindow(history, t);
  return (metricFamily(metric) === "return" ? hourlyLogChanges(w).length : w.length) >= MIN_SAMPLES;
}

/**
 * The metric's z. `history` is the snapshot series; `coldStart` (1h candle
 * closes for price, hl.oi.<coin> for oi_usd, the funding table or
 * hl.funding|premium.<coin> for funding/premium) stands in when the snapshot
 * store is still too young. The ratio family has no cold start.
 */
export function metricZ(metric: SnapshotMetric, a: { from: Point; to: Point; history: Point[]; coldStart?: Point[] }): number | null {
  const family = metricFamily(metric);
  const history = family !== "ratio" && a.coldStart?.length && !hasSamples(metric, a.history, a.to.t) ? a.coldStart : a.history;
  if (family === "return") return returnZ(a.from, a.to, history);
  if (family === "level") return levelZ(a.to, history);
  return ratioZ(a.to, history);
}
