import type { Direction } from "../types.js";
import { parseDay, quantileSorted, sortedFinite } from "./util.js";

// Labels (LAB.md §2): day t is good (1) when the forward return over
// horizonDays clears the labelQuantile tail of the search region and has the
// right sign. Days whose forward window reaches past `end` (the search
// region's edge) are NaN, so holdout prices never shape a label.

/** fwd[t] = price[t+h]/price[t] − 1 for t + h < end; NaN otherwise or when a price is missing. */
export function forwardReturns(price: ArrayLike<number>, h: number, end: number): Float64Array {
  const n = price.length;
  const out = new Float64Array(n).fill(NaN);
  for (let t = 0; t + h < Math.min(end, n); t++) {
    const a = price[t]!;
    const b = price[t + h]!;
    if (a > 0 && b > 0 && Number.isFinite(a) && Number.isFinite(b)) out[t] = b / a - 1;
  }
  return out;
}

export interface LabelOptions {
  t: number[];
  price: ArrayLike<number>;
  horizonDays: number;
  direction: Direction;
  quantile: number;
  /** Exclusive end of the search region (index). */
  end: number;
  customZones?: Array<{ from: string; to: string }>;
}

export function makeLabels(o: LabelOptions): Float64Array {
  const n = o.t.length;
  const end = Math.min(o.end, n);
  if (o.customZones?.length) {
    const zones = o.customZones.map((z) => [parseDay(z.from), parseDay(z.to)] as const);
    const out = new Float64Array(n).fill(NaN);
    for (let i = 0; i < end; i++) out[i] = zones.some(([a, b]) => o.t[i]! >= a && o.t[i]! <= b) ? 1 : 0;
    return out;
  }
  const fwd = forwardReturns(o.price, o.horizonDays, end);
  const sorted = sortedFinite(fwd, 0, end);
  const out = new Float64Array(n).fill(NaN);
  if (!sorted.length) return out;
  const long = o.direction === "long";
  const thr = quantileSorted(sorted, long ? 1 - o.quantile : o.quantile);
  for (let i = 0; i < end; i++) {
    const f = fwd[i]!;
    if (f !== f) continue;
    out[i] = long ? (f >= thr && f > 0 ? 1 : 0) : f <= thr && f < 0 ? 1 : 0;
  }
  return out;
}
