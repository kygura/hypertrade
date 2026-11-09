// Dependency-free signal math shared by Intel, Desk, Platform, Radar, Routine and the Lab engine.
// Each variant below is the exact arithmetic its call sites used before; names say which one it is.

export const HOURS_PER_YEAR = 24 * 365;
/** Scales a MAD to a normal-consistent sigma. */
export const MAD_SCALE = 1.4826;

/** Hourly funding rate -> annualized fraction (HL settles hourly). */
export const fundingAprFrac = (hourly: number): number => hourly * 24 * 365;
/** Hourly funding rate -> annualized percent. */
export const fundingAprPct = (hourly: number): number => hourly * 24 * 365 * 100;

/** Arithmetic mean; NaN when empty. */
export function mean(xs: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < xs.length; i++) s += xs[i]!;
  return s / xs.length;
}

/** Sample standard deviation (n - 1); NaN below two values. */
export function sdSample(xs: number[]): number {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}

/** Population standard deviation (n); NaN below two values. */
export function sdPopulation(xs: number[]): number {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / xs.length);
}

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Median absolute deviation, unscaled. */
export function mad(xs: number[]): number {
  const m = median(xs);
  return median(xs.map((x) => Math.abs(x - m)));
}

/** Linear-interpolated quantile of an ascending array (q clamped to 0..1); NaN when empty. */
export function quantile(s: ArrayLike<number>, q: number): number {
  const m = s.length;
  if (!m) return NaN;
  const pos = Math.min(1, Math.max(0, q)) * (m - 1);
  const i = Math.floor(pos);
  const f = pos - i;
  return i + 1 < m ? s[i]! + f * (s[i + 1]! - s[i]!) : s[i]!;
}

/** MAD-based sigma, never below `floor`. */
export function robustSigma(xs: number[], floor: number): number {
  return Math.max(floor, mad(xs) * MAD_SCALE);
}

/** z of `x` against `base` with the sample sd (x is not part of `base`); null when the sd is not positive. */
export function zSample(x: number, base: number[]): number | null {
  const s = sdSample(base);
  return s > 0 ? (x - mean(base)) / s : null;
}

/** z of `x` against `base` with the population sd; null when `base` has under `minN` values or is flat. */
export function zPopulation(x: number, base: number[], minN: number): number | null {
  if (base.length < minN) return null;
  const s = sdPopulation(base);
  if (!Number.isFinite(s) || s === 0) return null;
  return (x - mean(base)) / s;
}

/** Robust z of `x` against `base`: (x - median) / max(floor, MAD * 1.4826). Caller owns the min-obs rule. */
export function zRobust(x: number, base: number[], floor: number): number {
  return (x - median(base)) / robustSigma(base, floor);
}

/**
 * Mean true range over the `period` bars ending at index j of parallel high/low/close arrays.
 * NaN when j < period or any bar it reads is NaN.
 */
export function atrAt(h: ArrayLike<number>, l: ArrayLike<number>, c: ArrayLike<number>, j: number, period: number): number {
  if (j < period) return NaN;
  let s = 0;
  for (let i = j - period + 1; i <= j; i++) s += Math.max(h[i]! - l[i]!, Math.abs(h[i]! - c[i - 1]!), Math.abs(l[i]! - c[i - 1]!));
  return s / period;
}

/** Average true range over the last `period` bars; null until there are period + 1. */
export function atr(bars: Array<{ h: number; l: number; c: number }>, period = 14): number | null {
  if (bars.length <= period) return null;
  return atrAt(bars.map((b) => b.h), bars.map((b) => b.l), bars.map((b) => b.c), bars.length - 1, period);
}
