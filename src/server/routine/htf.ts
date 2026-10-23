import type { Candle } from "../../shared/types.js";

// Higher-timeframe features per major (docs/fallback-routine.md, pipeline
// step 3). Pure and deterministic: the model reads these numbers, it never
// computes them. The last daily/weekly candle may still be forming; it
// counts as the current close, the way a chart shows it.

export interface HtfFeatures {
  close: number;
  sma20w: number | null;
  sma50w: number | null;
  sma200d: number | null;
  /** Close vs each average, percent. */
  vs20wPct: number | null;
  vs50wPct: number | null;
  vs200dPct: number | null;
  high52w: number | null;
  low52w: number | null;
  fromHighPct: number | null;
  fromLowPct: number | null;
  /** 30-day realised volatility of daily log returns, annualised (365 d), percent. */
  rv30Pct: number | null;
  ret4wPct: number | null;
  /** 20W SMA change over the last 4 weeks, percent. */
  sma20wSlope4wPct: number | null;
  trend: "up" | "down" | "range" | null;
}

const pct = (a: number, b: number) => ((a - b) / b) * 100;
const round = (x: number | null, dp = 2) => (x === null || !Number.isFinite(x) ? null : Math.round(x * 10 ** dp) / 10 ** dp);

/** Mean of the last n closes ending `back` candles before the end; null when there are fewer. */
export function sma(candles: Candle[], n: number, back = 0): number | null {
  const end = candles.length - back;
  if (n <= 0 || end - n < 0) return null;
  let sum = 0;
  for (let i = end - n; i < end; i++) sum += candles[i]!.c;
  return sum / n;
}

export function realisedVol(daily: Candle[], days = 30): number | null {
  if (daily.length < days + 1) return null;
  const rets: number[] = [];
  for (let i = daily.length - days; i < daily.length; i++) rets.push(Math.log(daily[i]!.c / daily[i - 1]!.c));
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, r) => a + (r - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(variance) * Math.sqrt(365) * 100;
}

/**
 * Weekly trend label: `up` when the close is above both the 20W and 50W
 * SMA and the 20W SMA is rising over four weeks; `down` mirrored; else
 * `range`. Null without 50 weeks of history.
 */
export function htfFeatures(daily: Candle[], weekly: Candle[]): HtfFeatures | null {
  const last = daily.at(-1) ?? weekly.at(-1);
  if (!last) return null;
  const close = last.c;
  const sma20w = sma(weekly, 20);
  const sma50w = sma(weekly, 50);
  const sma20wPrev = sma(weekly, 20, 4);
  const sma200d = sma(daily, 200);
  const year = daily.slice(-365);
  const high52w = year.length >= 365 ? Math.max(...year.map((c) => c.h)) : null;
  const low52w = year.length >= 365 ? Math.min(...year.map((c) => c.l)) : null;
  const ago4w = daily.length > 28 ? daily[daily.length - 29]!.c : null;
  const slope = sma20w !== null && sma20wPrev !== null ? pct(sma20w, sma20wPrev) : null;
  let trend: HtfFeatures["trend"] = null;
  if (sma20w !== null && sma50w !== null && slope !== null) {
    if (close > sma20w && close > sma50w && slope > 0) trend = "up";
    else if (close < sma20w && close < sma50w && slope < 0) trend = "down";
    else trend = "range";
  }
  return {
    close,
    sma20w: round(sma20w),
    sma50w: round(sma50w),
    sma200d: round(sma200d),
    vs20wPct: round(sma20w === null ? null : pct(close, sma20w)),
    vs50wPct: round(sma50w === null ? null : pct(close, sma50w)),
    vs200dPct: round(sma200d === null ? null : pct(close, sma200d)),
    high52w,
    low52w,
    fromHighPct: round(high52w === null ? null : pct(close, high52w)),
    fromLowPct: round(low52w === null ? null : pct(close, low52w)),
    rv30Pct: round(realisedVol(daily)),
    ret4wPct: round(ago4w === null ? null : pct(close, ago4w)),
    sma20wSlope4wPct: round(slope),
    trend,
  };
}
