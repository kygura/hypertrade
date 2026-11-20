// Regime labels for each day (docs/EVAL.md §2), read only from data up to that day's close, so a strategy gated on
// the regime never sees the future. Five labels, checked in this order:
//   capitulation  price under the STH cost basis by more than `capGap` with sentiment in extreme fear (≤ capFng), or a
//                 drawdown from the 365-day high deeper than `capDd`: the "raw and deep" washout
//   euphoria      MVRV over `euMvrv`, or price over the STH cost basis by more than `euGap` with greed (≥ euFng)
//   bull          over the 200-day mean, the 50-day mean rising, and over the STH cost basis
//   bear          under the 200-day mean with the 50-day mean falling
//   range         anything else (the chop between)
import { trailingMean } from "./panel.js";

export const REGIMES = ["capitulation", "bear", "range", "bull", "euphoria"] as const;
export type Regime = (typeof REGIMES)[number];

export interface RegimeParams {
  capGap: number;
  capFng: number;
  capDd: number;
  euMvrv: number;
  euGap: number;
  euFng: number;
}

export const DEFAULT_REGIME_PARAMS: RegimeParams = { capGap: 0.1, capFng: 20, capDd: 0.55, euMvrv: 3, euGap: 0.4, euFng: 75 };

export interface RegimePanel {
  price: number[];
  sthRp: number[];
  fng: number[];
  mvrv: number[];
}

/** Running max of the last `win` values (NaN-safe). */
export function rollingMax(x: readonly number[], win: number): number[] {
  const out = new Array<number>(x.length).fill(NaN);
  const dq: number[] = [];
  for (let i = 0; i < x.length; i++) {
    const v = x[i]!;
    if (Number.isFinite(v)) {
      while (dq.length && x[dq[dq.length - 1]!]! <= v) dq.pop();
      dq.push(i);
    }
    while (dq.length && dq[0]! <= i - win) dq.shift();
    if (dq.length) out[i] = x[dq[0]!]!;
  }
  return out;
}

/**
 * Causal hysteresis: the label changes only once the raw label has held for `minRun` days in a row, so one noisy day
 * does not flip the regime (and the transition matrix measures real regime changes, not label noise).
 */
export function smoothRegimes(raw: readonly Regime[], minRun = 5): Regime[] {
  const out: Regime[] = [];
  let cur: Regime | undefined;
  let run = 0;
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i]!;
    run = i > 0 && raw[i - 1] === r ? run + 1 : 1;
    if (cur === undefined || (r !== cur && run >= minRun)) cur = r;
    out.push(cur);
  }
  return out;
}

export function labelRegimes(p: RegimePanel, params: RegimeParams = DEFAULT_REGIME_PARAMS, minRun = 5): Regime[] {
  return smoothRegimes(rawRegimes(p, params), minRun);
}

/** The day-by-day label before smoothing. */
export function rawRegimes(p: RegimePanel, params: RegimeParams = DEFAULT_REGIME_PARAMS): Regime[] {
  const ma200 = trailingMean(p.price, 200);
  const ma50 = trailingMean(p.price, 50);
  const hi = rollingMax(p.price, 365);
  return p.price.map((px, i): Regime => {
    const sth = p.sthRp[i]!;
    const gap = Number.isFinite(sth) && sth > 0 ? px / sth - 1 : NaN;
    const fng = p.fng[i]!;
    const dd = Number.isFinite(hi[i]!) ? 1 - px / hi[i]! : 0;
    if ((gap < -params.capGap && (!Number.isFinite(fng) || fng <= params.capFng)) || dd > params.capDd) return "capitulation";
    if (p.mvrv[i]! > params.euMvrv || (gap > params.euGap && fng >= params.euFng)) return "euphoria";
    const m200 = ma200[i]!;
    const slope = i >= 10 && Number.isFinite(ma50[i - 10]!) ? ma50[i]! / ma50[i - 10]! - 1 : NaN;
    if (!Number.isFinite(m200) || !Number.isFinite(slope)) return "range";
    if (px > m200 && slope > 0 && !(gap < 0)) return "bull";
    if (px < m200 && slope < 0) return "bear";
    return "range";
  });
}

/** Days per regime. */
export function regimeCounts(labels: readonly Regime[]): Record<Regime, number> {
  const out = Object.fromEntries(REGIMES.map((r) => [r, 0])) as Record<Regime, number>;
  for (const r of labels) out[r]++;
  return out;
}

/** Empirical next-day transition matrix between regimes (rows sum to 1, a row with no days is uniform). */
export function transitionMatrix(labels: readonly Regime[]): Record<Regime, Record<Regime, number>> {
  const count = Object.fromEntries(REGIMES.map((a) => [a, Object.fromEntries(REGIMES.map((b) => [b, 0]))])) as Record<Regime, Record<Regime, number>>;
  for (let i = 1; i < labels.length; i++) count[labels[i - 1]!][labels[i]!]++;
  for (const a of REGIMES) {
    const tot = REGIMES.reduce((s, b) => s + count[a][b], 0);
    for (const b of REGIMES) count[a][b] = tot ? count[a][b] / tot : 1 / REGIMES.length;
  }
  return count;
}
