// Normal distribution helpers and the deflated Sharpe ratio. Pure.

/** Standard normal CDF (Abramowitz & Stegun 7.1.26 via erf; |error| < 1.5e-7). */
export function normCdf(x: number): number {
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return x >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

/** Inverse standard normal CDF (Acklam; relative error < 1.2e-9). */
export function normInv(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  if (p > 1 - lo) return -normInv(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
}

const EULER_GAMMA = 0.5772156649015329;

/**
 * Expected maximum Sharpe among `trials` independent strategies with zero true
 * Sharpe whose estimates have variance `trialVar` (False Strategy Theorem).
 */
export function expectedMaxSharpe(trials: number, trialVar: number): number {
  if (trials < 2 || trialVar <= 0) return 0;
  return Math.sqrt(trialVar) * ((1 - EULER_GAMMA) * normInv(1 - 1 / trials) + EULER_GAMMA * normInv(1 - 1 / (trials * Math.E)));
}

/**
 * Deflated Sharpe ratio (Bailey & López de Prado, 2014): the probability the
 * true Sharpe exceeds what the best of `trials` noise strategies would show.
 * All Sharpes are per-period (daily), not annualized. `kurt` is raw kurtosis
 * (3 for a normal). Trials in a rule search are correlated, so counting every
 * one makes this conservative.
 */
export function deflatedSharpe(sr: number, n: number, skew: number, kurt: number, trials: number, trialVar: number): number {
  if (!Number.isFinite(sr) || n < 3) return 0;
  const sr0 = expectedMaxSharpe(trials, trialVar);
  const den = 1 - skew * sr + ((kurt - 1) / 4) * sr * sr;
  if (den <= 0) return 0;
  return normCdf(((sr - sr0) * Math.sqrt(n - 1)) / Math.sqrt(den));
}

/** Quantile of the finite values in x[a, b) (linear interpolation). */
export function quantile(x: Float64Array, a: number, b: number, q: number): number {
  const vals: number[] = [];
  for (let t = a; t < b; t++) {
    const v = x[t]!;
    if (Number.isFinite(v)) vals.push(v);
  }
  return quantileSorted(vals.sort((p, r) => p - r), q);
}

export function quantileSorted(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}
