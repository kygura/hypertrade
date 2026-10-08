// Signal backtester. Pure, no I/O.
//
// Timing: sig[t] is decided at the close of day t from data known by then,
// and earns the return from close t to close t+1. A position change between
// t-1 and t pays `cost` (a fraction, e.g. 10 bps = 0.001) once. Out of the
// market means flat cash at 0%: no funding, no yield.
import type { LabDirection, LabStats } from "../../shared/lab.js";
import { isoDay } from "./features.js";

export const PERIODS_PER_YEAR = 365;

/** r[t] = close[t] / close[t-1] - 1; 0 where either close is missing. */
export function dailyReturns(close: Float64Array): Float64Array {
  const r = new Float64Array(close.length);
  for (let t = 1; t < close.length; t++) {
    const a = close[t - 1]!;
    const b = close[t]!;
    r[t] = Number.isFinite(a) && Number.isFinite(b) && a > 0 ? b / a - 1 : 0;
  }
  return r;
}

const sign = (d: LabDirection) => (d === "short" ? -1 : 1);

/**
 * Net strategy returns for decision days t in [a, b): element k is the
 * return earned from close a+k to close a+k+1. Requires b <= r.length - 1.
 * The position before `a` is taken as flat, so a window that opens in the
 * market pays the entry cost.
 */
export function strategyReturns(sig: Uint8Array, r: Float64Array, dir: LabDirection, cost: number, a: number, b: number): Float64Array {
  const s = sign(dir);
  const out = new Float64Array(Math.max(0, b - a));
  let prev = 0;
  for (let t = a; t < b; t++) {
    const p = sig[t]!;
    out[t - a] = s * p * r[t + 1]! - (p !== prev ? cost : 0);
    prev = p;
  }
  return out;
}

export interface QuickScore {
  /** Per-period (daily) Sharpe of net returns; NaN when a constraint fails. */
  sr: number;
  exposure: number;
  trades: number;
  /**
   * With fold bounds: mean minus half the spread of the per-fold Sharpes, so
   * a rule that works in every fold outranks one carried by a single stretch.
   * Equals `sr` without bounds; NaN when a constraint fails.
   */
  score: number;
}

export interface ScoreLimits {
  minExposure: number;
  maxExposure: number;
  minTrades: number;
}

const srOf = (sum: number, ss: number, n: number) => {
  if (n < 2) return NaN;
  const mean = sum / n;
  const sd = Math.sqrt(Math.max(0, ss / n - mean * mean) * (n / (n - 1)));
  return sd > 0 ? mean / sd : NaN;
};

/**
 * Single-pass Sharpe, exposure and entry count over [a, b): the search's
 * inner loop. `bounds` (ascending, within [a, b)) splits the window into
 * folds for the consistency score.
 */
export function quickScore(sig: Uint8Array, r: Float64Array, dir: LabDirection, cost: number, a: number, b: number, lim: ScoreLimits, bounds?: number[]): QuickScore {
  const s = sign(dir);
  let sum = 0;
  let ss = 0;
  let inMkt = 0;
  let trades = 0;
  let prev = 0;
  const folds: number[] = [];
  let fSum = 0;
  let fSs = 0;
  let fN = 0;
  let next = bounds ? 1 : -1;
  for (let t = a; t < b; t++) {
    if (bounds && next < bounds.length && t === bounds[next]) {
      folds.push(srOf(fSum, fSs, fN));
      fSum = fSs = fN = 0;
      next++;
    }
    const p = sig[t]!;
    const x = s * p * r[t + 1]! - (p !== prev ? cost : 0);
    if (p === 1) {
      inMkt++;
      if (prev === 0) trades++;
    }
    sum += x;
    ss += x * x;
    fSum += x;
    fSs += x * x;
    fN++;
    prev = p;
  }
  const n = b - a;
  const exposure = n > 0 ? inMkt / n : 0;
  if (n < 2 || exposure < lim.minExposure || exposure > lim.maxExposure || trades < lim.minTrades) {
    return { sr: NaN, exposure, trades, score: NaN };
  }
  const sr = srOf(sum, ss, n);
  if (!bounds) return { sr, exposure, trades, score: sr };
  folds.push(srOf(fSum, fSs, fN));
  // A fold spent entirely in cash has no Sharpe; it counts as zero edge.
  const fs = folds.map((v) => (Number.isFinite(v) ? v : 0));
  const mean = fs.reduce((u, v) => u + v, 0) / fs.length;
  const sd = Math.sqrt(fs.reduce((u, v) => u + (v - mean) ** 2, 0) / fs.length);
  return { sr, exposure, trades, score: Number.isFinite(sr) ? mean - 0.5 * sd : NaN };
}

export function sharpe(x: Float64Array): number {
  const n = x.length;
  if (n < 2) return 0;
  let sum = 0;
  for (const v of x) sum += v;
  const mean = sum / n;
  let ss = 0;
  for (const v of x) ss += (v - mean) ** 2;
  const sd = Math.sqrt(ss / (n - 1));
  return sd > 0 ? (mean / sd) * Math.sqrt(PERIODS_PER_YEAR) : 0;
}

export function maxDrawdown(x: Float64Array): number {
  let eq = 1;
  let peak = 1;
  let dd = 0;
  for (const v of x) {
    eq *= 1 + v;
    if (eq > peak) peak = eq;
    dd = Math.min(dd, eq / peak - 1);
  }
  return dd;
}

const compound = (x: Float64Array) => x.reduce((eq, v) => eq * (1 + v), 1);

/** Full window stats for a report. `days` are the grid's UTC day starts. */
export function windowStats(
  sig: Uint8Array,
  r: Float64Array,
  dir: LabDirection,
  cost: number,
  a: number,
  b: number,
  days: number[],
): LabStats {
  const ret = strategyReturns(sig, r, dir, cost, a, b);
  const bench = new Float64Array(ret.length);
  const s = sign(dir);
  for (let t = a; t < b; t++) bench[t - a] = s * r[t + 1]!;

  let inMkt = 0;
  let trades = 0;
  let wins = 0;
  let run = 1;
  let prev = 0;
  for (let t = a; t < b; t++) {
    const p = sig[t]!;
    if (p === 1) {
      inMkt++;
      if (prev === 0) {
        trades++;
        run = 1;
      }
      run *= 1 + ret[t - a]!;
    } else if (prev === 1) {
      run *= 1 + ret[t - a]!; // the exit day carries the exit cost
      if (run > 1) wins++;
    }
    prev = p;
  }
  if (prev === 1 && run > 1) wins++; // a trade still open at the window's end counts at its mark

  const n = ret.length;
  const total = compound(ret);
  const years = n / PERIODS_PER_YEAR;
  return {
    from: isoDay(days[a] ?? 0),
    to: isoDay(days[Math.min(b, days.length - 1)] ?? 0),
    days: n,
    totalReturnPct: (total - 1) * 100,
    cagrPct: years > 0 && total > 0 ? (total ** (1 / years) - 1) * 100 : -100,
    sharpe: sharpe(ret),
    maxDrawdownPct: maxDrawdown(ret) * 100,
    exposure: n > 0 ? inMkt / n : 0,
    trades,
    winRate: trades > 0 ? wins / trades : null,
    benchmark: { totalReturnPct: (compound(bench) - 1) * 100, sharpe: sharpe(bench), maxDrawdownPct: maxDrawdown(bench) * 100 },
  };
}

/** Strategy and benchmark equity over [a, b), downsampled to about `points` rows. */
export function equityCurve(
  sig: Uint8Array,
  r: Float64Array,
  dir: LabDirection,
  cost: number,
  a: number,
  b: number,
  days: number[],
  points = 160,
): { ts: string; strategy: number; benchmark: number }[] {
  const ret = strategyReturns(sig, r, dir, cost, a, b);
  const s = sign(dir);
  const step = Math.max(1, Math.ceil(ret.length / points));
  const out: { ts: string; strategy: number; benchmark: number }[] = [];
  let eq = 1;
  let bq = 1;
  for (let k = 0; k < ret.length; k++) {
    eq *= 1 + ret[k]!;
    bq *= 1 + s * r[a + k + 1]!;
    if (k % step === 0 || k === ret.length - 1) {
      out.push({ ts: isoDay(days[a + k + 1] ?? 0), strategy: round4(eq), benchmark: round4(bq) });
    }
  }
  return out;
}

const round4 = (v: number) => Math.round(v * 1e4) / 1e4;

/** Sample skewness and raw (non-excess) kurtosis. */
export function moments(x: Float64Array): { skew: number; kurt: number } {
  const n = x.length;
  if (n < 4) return { skew: 0, kurt: 3 };
  let sum = 0;
  for (const v of x) sum += v;
  const m = sum / n;
  let m2 = 0;
  let m3 = 0;
  let m4 = 0;
  for (const v of x) {
    const d = v - m;
    m2 += d * d;
    m3 += d * d * d;
    m4 += d * d * d * d;
  }
  m2 /= n;
  m3 /= n;
  m4 /= n;
  if (m2 === 0) return { skew: 0, kurt: 3 };
  return { skew: m3 / m2 ** 1.5, kurt: m4 / (m2 * m2) };
}
