// Joins perp series onto candle bars so every chart pane shares one time
// axis. Pure and free of server imports so the UI can bundle it; the candles
// route feeds it stored funding and OI snapshots, the UI feeds it HL pages.
import type { ChartBar } from "./market.js";
import { TF_MS, type Timeframe } from "./timeframes.js";

export type { ChartBar };

export interface Bar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  src: string;
}

/** Start of the UTC calendar month containing t, shifted by `add` months. */
export function monthStart(t: number, add = 0): number {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + add, 1);
}

/** Open time of the bar after the one opening at t. */
export function nextBarT(t: number, tf: Timeframe): number {
  return tf === "1M" ? monthStart(t, 1) : t + TF_MS[tf];
}

const HOUR = 3_600_000;
const OI_STALE_MS = 30 * 60_000;

/** First index with arr[i].t > x (arr ascending). */
function upperBound(arr: { t: number }[], x: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid]!.t <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** First index with arr[i].t >= x. */
function lowerBound(arr: { t: number }[], x: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid]!.t < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * A settlement at ts pays for [ts-1h, ts), so a bar [t, end) owns the
 * settlements in (t, end]. Bars shorter than an hour take the one settlement
 * of the hour they sit in, (t, t+1h]. OI snapshots land every ~15 minutes;
 * short bars look back up to 30 minutes so the line doesn't dot.
 */
export function joinOverlays(
  bars: Bar[],
  tf: Timeframe,
  funding: { t: number; rate: number; premium: number }[],
  oi: { t: number; v: number }[],
): ChartBar[] {
  return bars.map((bar, i) => {
    const end = i + 1 < bars.length ? bars[i + 1]!.t : nextBarT(bar.t, tf);
    const span = end - bar.t;

    let f: number | null = null;
    let p: number | null = null;
    const hi = bar.t + Math.max(span, HOUR);
    let n = 0;
    let sumF = 0;
    let sumP = 0;
    for (let k = upperBound(funding, bar.t); k < funding.length && funding[k]!.t <= hi; k++) {
      sumF += funding[k]!.rate;
      sumP += funding[k]!.premium;
      n++;
    }
    if (n > 0) {
      f = sumF / n;
      p = sumP / n;
    }

    let oiV: number | null = null;
    const last = lowerBound(oi, end) - 1;
    if (last >= 0 && oi[last]!.t >= end - Math.max(span, OI_STALE_MS)) oiV = oi[last]!.v;

    return { ...bar, f, p, oi: oiV };
  });
}
