// Normal distribution helpers and the deflated Sharpe ratio (LAB.md §7).

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
 * Sharpes are per-period (daily), not annualised; `kurt` is raw kurtosis (3
 * for a normal). Trials in a rule search are correlated: a search passes the
 * effective number of independent trials (trials.ts), not the raw count.
 */
export function deflatedSharpe(sr: number, n: number, skew: number, kurt: number, trials: number, trialVar: number): number | null {
  if (!Number.isFinite(sr) || n < 3) return 0;
  const sr0 = expectedMaxSharpe(trials, trialVar);
  const den = 1 - skew * sr + ((kurt - 1) / 4) * sr * sr;
  // Extreme skew/kurtosis: the Sharpe's standard error is undefined, so is the DSR.
  if (!(den > 0)) return null;
  return normCdf(((sr - sr0) * Math.sqrt(n - 1)) / Math.sqrt(den));
}

/** Sample skewness and raw (non-excess) kurtosis. */
export function moments(x: ArrayLike<number>): { skew: number; kurt: number } {
  const n = x.length;
  if (n < 4) return { skew: 0, kurt: 3 };
  let sum = 0;
  for (let i = 0; i < n; i++) sum += x[i]!;
  const m = sum / n;
  let m2 = 0;
  let m3 = 0;
  let m4 = 0;
  for (let i = 0; i < n; i++) {
    const d = x[i]! - m;
    m2 += d * d;
    m3 += d * d * d;
    m4 += d * d * d * d;
  }
  m2 /= n;
  m3 /= n;
  m4 /= n;
  if (m2 < 1e-24) return { skew: 0, kurt: 3 };
  return { skew: m3 / m2 ** 1.5, kurt: m4 / (m2 * m2) };
}

/**
 * Deflated Sharpe of a daily return track picked as the best of `trials`
 * variants; null with fewer than 4 days or when undefined (extreme skew/kurtosis). Trial dispersion under the null is
 * Var(SR) ≈ 1/(T − 1): the empirical spread of trial Sharpes would also count
 * real signal and the overlap between variants.
 */
export function deflatedSharpeOf(ret: ArrayLike<number>, trials: number): number | null {
  const T = ret.length;
  if (T < 4) return null;
  let s = 0;
  for (let i = 0; i < T; i++) s += ret[i]!;
  const m = s / T;
  let ss = 0;
  for (let i = 0; i < T; i++) ss += (ret[i]! - m) ** 2;
  const sd = Math.sqrt(ss / (T - 1));
  const sr = sd > 1e-12 ? m / sd : 0;
  const { skew, kurt } = moments(ret);
  return deflatedSharpe(sr, T, skew, kurt, Math.max(1, trials), 1 / (T - 1));
}
