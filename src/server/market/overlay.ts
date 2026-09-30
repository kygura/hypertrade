// Joins perp series onto candle bars so every chart pane shares one time
// axis. Pure; the candles route feeds it stored funding and OI snapshots.
import type { ChartBar } from "../../shared/market.js";
import type { Timeframe } from "../../shared/timeframes.js";
import { nextBarT, type Bar } from "./candleSync.js";

export type { ChartBar };

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
