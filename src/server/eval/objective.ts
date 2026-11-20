// The eval function (docs/EVAL.md §4). One number to rank strategies, built so that a higher Sharpe only wins when it
// does not come with deeper drawdowns, fatter left tails or more implied vol carried:
//
//   score = Sharpe − wDD·MaxDD − wTail·CVaR95(ann) − wIV·IVcarry + wRobust·min(regime Sharpe) − wTurn·turnover
//
//   Sharpe     annualized (√365) on daily returns after costs: fees on every change of position and perp funding
//              (a long pays positive funding, a short receives it)
//   MaxDD      deepest peak-to-trough of the compounded equity (0..1), measured with the returns rescaled to
//              RISK_VOL annualized vol, so a strategy cannot lower it just by trading smaller
//   CVaR95     mean of the worst 5% of daily returns at the same RISK_VOL scale, annualized by √365 (loss > 0)
//   IVcarry    implied vol where the strategy holds, over the asset's average implied vol, minus 1: above 0 it sits
//              in the market when options price more risk than usual, below 0 when they price less
//   regime     Sharpe inside each regime the strategy held at least `minRegimeDays` days in; the worst one counts, so
//              a strategy that only works in one regime pays for it
//   turnover   mean |Δposition| per day × 365, at the same RISK_VOL scale in the score (so trading smaller does not
//              lower it; the raw value is reported as `turnover`)
//
// The weights live in OBJECTIVE_WEIGHTS and are part of the fixed harness (like autoresearch's prepare.py): the search
// never changes them. Walk-forward: the score that drives the search is the mean over `folds` consecutive in-sample
// windows minus their spread; the last `holdoutFrac` of the history is never seen by the search and is reported once,
// for the finalists only.
import { deflatedSharpeOf } from "../lab/engine/stats.js";
import { logReturns, type EvalPanel } from "./panel.js";
import { REGIMES, type Regime } from "./regimes.js";

export const OBJECTIVE_WEIGHTS = { dd: 1, tail: 0.25, iv: 1, robust: 0.15, turn: 0.002, foldSpread: 0.5 } as const;
export const COST_BPS = 5;
/** Annualized vol the drawdown and tail terms are measured at. */
export const RISK_VOL = 0.2;
export const MIN_REGIME_DAYS = 60;
export const HOLDOUT_FRAC = 0.2;
export const FOLDS = 4;

export interface Metrics {
  days: number;
  exposure: number;
  totalReturn: number;
  cagr: number;
  sharpe: number;
  sortino: number;
  /** At the strategy's own size. */
  maxDD: number;
  /** At RISK_VOL (what the score uses). */
  maxDDAtRisk: number;
  cvar95: number;
  ivCarry: number;
  turnover: number;
  regimeSharpe: Partial<Record<Regime, number>>;
  worstRegime: Regime | null;
  score: number;
}

export interface Backtest {
  ret: number[];
  pos: number[];
}

/** Daily strategy returns on [a, b): pos[i-1] earns the simple return of day i, minus fees and funding. */
export function backtest(d: EvalPanel, pos: readonly number[], a = 1, b = d.price.length, costBps = COST_BPS): Backtest {
  const lr = logReturns(d.price);
  const ret: number[] = [];
  const held: number[] = [];
  for (let i = Math.max(1, a); i < b; i++) {
    const w = pos[i - 1] ?? 0;
    const prev = i >= 2 ? (pos[i - 2] ?? 0) : 0;
    const simple = Math.expm1(lr[i]!);
    const f = d.funding[i];
    const funding = Number.isFinite(f) ? w * f! : 0;
    ret.push(w * simple - funding - (costBps / 1e4) * Math.abs(w - prev));
    held.push(w);
  }
  return { ret, pos: held };
}

const mean = (x: readonly number[]) => (x.length ? x.reduce((s, v) => s + v, 0) / x.length : 0);
function sd(x: readonly number[]): number {
  if (x.length < 2) return 0;
  const m = mean(x);
  return Math.sqrt(x.reduce((s, v) => s + (v - m) ** 2, 0) / (x.length - 1));
}

export function sharpe(ret: readonly number[]): number {
  const s = sd(ret);
  return s > 0 ? (mean(ret) / s) * Math.sqrt(365) : 0;
}

export function sortino(ret: readonly number[]): number {
  const down = Math.sqrt(mean(ret.map((r) => Math.min(0, r) ** 2)));
  return down > 0 ? (mean(ret) / down) * Math.sqrt(365) : 0;
}

export function maxDrawdown(ret: readonly number[]): number {
  let eq = 1;
  let peak = 1;
  let dd = 0;
  for (const r of ret) {
    eq *= 1 + r;
    peak = Math.max(peak, eq);
    dd = Math.max(dd, 1 - eq / peak);
  }
  return dd;
}

/** Mean of the worst `alpha` share of daily returns, sign flipped (a loss is positive). */
export function cvar(ret: readonly number[], alpha = 0.05): number {
  if (!ret.length) return 0;
  const s = [...ret].sort((x, y) => x - y);
  const k = Math.max(1, Math.floor(s.length * alpha));
  return -mean(s.slice(0, k));
}

/** Metrics and score of `pos` on [a, b). `regimes` labels the same calendar as `d`. */
export function evaluate(d: EvalPanel, pos: readonly number[], regimes: readonly Regime[], a = 1, b = d.price.length): Metrics {
  const W = OBJECTIVE_WEIGHTS;
  const { ret, pos: held } = backtest(d, pos, a, b);
  const days = ret.length;
  const exposed = held.filter((w) => w !== 0).length;
  const total = ret.reduce((e, r) => e * (1 + r), 1) - 1;
  let ivHeld = 0;
  let wHeld = 0;
  let ivAll = 0;
  let nAll = 0;
  held.forEach((w, j) => {
    const iv = d.iv[a + j - 1];
    if (!Number.isFinite(iv)) return;
    ivAll += iv!;
    nAll++;
    ivHeld += Math.abs(w) * iv!;
    wHeld += Math.abs(w);
  });
  let turn = 0;
  for (let j = 1; j < held.length; j++) turn += Math.abs(held[j]! - held[j - 1]!);
  const byRegime = new Map<Regime, number[]>();
  held.forEach((w, j) => {
    if (w === 0) return;
    const r = regimes[a + j - 1]!;
    if (!byRegime.has(r)) byRegime.set(r, []);
    byRegime.get(r)!.push(ret[j]!);
  });
  const regimeSharpe: Partial<Record<Regime, number>> = {};
  let worst: Regime | null = null;
  for (const r of REGIMES) {
    const xs = byRegime.get(r);
    if (!xs || xs.length < MIN_REGIME_DAYS) continue;
    regimeSharpe[r] = sharpe(xs);
    if (worst === null || regimeSharpe[r]! < regimeSharpe[worst]!) worst = r;
  }
  const s = sharpe(ret);
  const vol = sd(ret) * Math.sqrt(365);
  const k = vol > 0 ? RISK_VOL / vol : 1;
  const scaled = ret.map((r) => r * k);
  const dd = maxDrawdown(scaled);
  const tail = cvar(scaled) * Math.sqrt(365);
  const ivCarry = wHeld > 0 && nAll > 0 && ivAll > 0 ? ivHeld / wHeld / (ivAll / nAll) - 1 : 0;
  const turnover = days ? (turn / days) * 365 : 0;
  const robust = worst ? Math.max(-2, Math.min(2, regimeSharpe[worst]!)) : 0;
  // A strategy that almost never holds has an undefined edge: its score is pulled toward zero by its exposure.
  const expo = days ? exposed / days : 0;
  const raw = s - W.dd * dd - W.tail * tail - W.iv * ivCarry + W.robust * robust - W.turn * turnover * k;
  const score = raw > 0 ? raw * Math.min(1, expo / 0.05) : raw;
  const years = days / 365;
  return {
    days,
    exposure: expo,
    totalReturn: total,
    cagr: years > 0 && total > -1 ? (1 + total) ** (1 / years) - 1 : -1,
    sharpe: s,
    sortino: sortino(ret),
    maxDD: maxDrawdown(ret),
    maxDDAtRisk: dd,
    cvar95: cvar(ret),
    ivCarry,
    turnover,
    regimeSharpe,
    worstRegime: worst,
    score,
  };
}

export interface Split {
  /** First index with every input warmed up. */
  start: number;
  /** First holdout index (the search never reads at or after it). */
  holdout: number;
  end: number;
  /** In-sample folds [a, b). */
  folds: Array<[number, number]>;
}

export function splitOf(n: number, start: number, folds = FOLDS, holdoutFrac = HOLDOUT_FRAC): Split {
  const holdout = Math.max(start + 2, Math.floor(start + (n - start) * (1 - holdoutFrac)));
  const len = Math.floor((holdout - start) / folds);
  const out: Array<[number, number]> = [];
  for (let k = 0; k < folds; k++) out.push([start + k * len, k === folds - 1 ? holdout : start + (k + 1) * len]);
  return { start, holdout, end: n, folds: out };
}

export interface FoldScore {
  score: number;
  folds: number[];
  /** In-sample days in the usable folds. */
  days: number;
  insample: Metrics;
}

/**
 * The search's number: mean fold score minus `foldSpread` × their standard deviation. `usable` drops folds where the
 * strategy's own input is missing (funding before an exchange listed the perp): being flat for want of data is not a
 * decision, and scoring it 0 would rank it above a strategy that traded a bad stretch. No usable fold: score NaN.
 */
export function foldScore(d: EvalPanel, pos: readonly number[], regimes: readonly Regime[], split: Split, usable: (a: number, b: number) => boolean = () => true): FoldScore {
  const kept = split.folds.filter(([a, b]) => usable(a, b));
  const folds = kept.map(([a, b]) => evaluate(d, pos, regimes, a, b).score);
  const days = kept.reduce((t, [a, b]) => t + b - a, 0);
  const score = folds.length ? mean(folds) - OBJECTIVE_WEIGHTS.foldSpread * sd(folds) : NaN;
  return { score, folds, days, insample: evaluate(d, pos, regimes, kept[0]?.[0] ?? split.start, split.holdout) };
}

/** Deflated Sharpe (Bailey & López de Prado) of the holdout returns given how many specs were tried. */
export function deflated(d: EvalPanel, pos: readonly number[], split: Split, trials: number): number | null {
  return deflatedSharpeOf(backtest(d, pos, split.holdout, split.end).ret, Math.max(2, trials));
}
