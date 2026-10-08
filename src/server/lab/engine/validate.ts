import type { Condition, Objective, Rule, Sensitivity, SensitivityPoint } from "../types.js";
import { objectiveOf, sharpeOf, simulate, totalReturnOf, type Segment } from "./backtest.js";
import type { EvalCtx } from "./context.js";
import { featureId, parseFeatureId } from "./features.js";
import { ecdf, quantileSorted } from "./util.js";

// Validation (LAB.md §7–8): holdout split, purged walk-forward folds,
// quantile-matched refits and threshold/window sensitivity.

export const HOLDOUT_FRAC = 0.2;
/** Minimum purged training rows in the first walk-forward fold. */
export const MIN_TRAIN_ROWS = 60;

export interface Fold {
  /** Training rows are [0, purgedEnd): the block edge minus horizonDays. */
  purgedEnd: number;
  /** Test return days [testFrom, testTo). */
  testFrom: number;
  testTo: number;
}

export interface Split {
  n: number;
  /** First holdout day; the search region is [0, searchEnd). */
  searchEnd: number;
  /** Final-fit training rows are [0, basisEnd): searchEnd minus horizonDays. */
  basisEnd: number;
  folds: Fold[];
}

export function makeSplit(n: number, folds: number, horizonDays: number): Split {
  const searchEnd = n - Math.floor(n * HOLDOUT_FRAC);
  const edges = Array.from({ length: folds + 2 }, (_, k) => Math.round((k * searchEnd) / (folds + 1)));
  return {
    n,
    searchEnd,
    basisEnd: searchEnd - horizonDays,
    folds: Array.from({ length: folds }, (_, i) => ({
      purgedEnd: edges[i + 1]! - horizonDays,
      testFrom: edges[i + 1]!,
      testTo: edges[i + 2]!,
    })),
  };
}

/** Same features and operators; each threshold moved to the quantile it sits at in [0, fromEnd), read in [0, toEnd). */
export function matchThresholds(ctx: EvalCtx, conds: Condition[], fromEnd: number, toEnd: number): Condition[] {
  return conds.map((c) => {
    const q = ecdf(ctx.sorted(c.feature, fromEnd), c.threshold);
    const thr = quantileSorted(ctx.sorted(c.feature, toEnd), q);
    return { ...c, threshold: Number.isFinite(thr) ? thr : c.threshold };
  });
}

/** Test-block segments of a rule refitted per fold by quantile matching. */
export function walkForwardSegments(ctx: EvalCtx, conds: Condition[], split: Split, dirSign: number, slippageBps: number): Segment[] {
  return split.folds.map((f) => {
    const fc = matchThresholds(ctx, conds, split.basisEnd, f.purgedEnd);
    const sig = ctx.signal(fc, f.testFrom - 1, f.testTo);
    return simulate(ctx.pr, positions(sig, dirSign), f.testFrom, f.testTo, slippageBps);
  });
}

export function positions(sig: Uint8Array, dirSign: number): Float64Array {
  const pos = new Float64Array(sig.length);
  for (let i = 0; i < sig.length; i++) pos[i] = sig[i] ? dirSign : 0;
  return pos;
}

export function walkForwardScore(segs: Segment[], objective: Objective): number {
  const all: number[] = [];
  for (const s of segs) for (const r of s.ret) all.push(r);
  return objectiveOf(all, objective);
}

export interface SensitivityOptions {
  /** Quantiles are read over training days [0, basisEnd). */
  basisEnd: number;
  /** Scored over return days [1, evalEnd). */
  evalEnd: number;
  windows: readonly number[];
  slippageBps: number;
}

const SHIFTS = [-0.1, -0.05, 0.05, 0.1];

/** Neighbouring windows of w within the configured set (nearest below and above). */
export function neighbourWindows(w: number, windows: readonly number[]): number[] {
  const ws = [...new Set(windows)].filter((x) => x !== w).sort((a, b) => a - b);
  const below = ws.filter((x) => x < w);
  const above = ws.filter((x) => x > w);
  return [below[below.length - 1], above[0]].filter((x): x is number => x != null);
}

export function sensitivity(ctx: EvalCtx, rule: Rule, o: SensitivityOptions): Sensitivity {
  const dirSign = rule.direction === "long" ? 1 : -1;
  const score = (conds: Condition[]) => {
    const seg = simulate(ctx.pr, positions(ctx.signal(conds, 0, o.evalEnd), dirSign), 1, o.evalEnd, o.slippageBps);
    return { sharpe: sharpeOf(seg.ret), totalReturn: totalReturnOf(seg.ret) };
  };
  const base = score(rule.conditions);
  const points: SensitivityPoint[] = [];
  rule.conditions.forEach((c, i) => {
    const s = ctx.sorted(c.feature, o.basisEnd);
    if (!s.length) return;
    const q = ecdf(s, c.threshold);
    for (const shift of SHIFTS) {
      const thr = quantileSorted(s, Math.min(1, Math.max(0, q + shift)));
      const conds = rule.conditions.map((x, k) => (k === i ? { ...x, threshold: thr } : x));
      points.push({ condition: i, kind: "threshold", shift, rule: { ...rule, conditions: conds }, ...score(conds) });
    }
    const spec = parseFeatureId(c.feature);
    if (spec.transform === "raw") return;
    for (const w of neighbourWindows(spec.window, o.windows)) {
      const id = featureId({ ...spec, window: w });
      let s2: Float64Array;
      try {
        s2 = ctx.sorted(id, o.basisEnd);
      } catch {
        continue;
      }
      // Thresholds are not comparable across windows (roc, vol): keep the quantile.
      const thr = quantileSorted(s2, q);
      if (!Number.isFinite(thr)) continue;
      const conds = rule.conditions.map((x, k) => (k === i ? { feature: id, op: x.op, threshold: thr } : x));
      points.push({ condition: i, kind: "window", shift: w, rule: { ...rule, conditions: conds }, ...score(conds) });
    }
  });
  const b = base.sharpe;
  const stable = points.filter((p) => b !== 0 && Math.sign(p.sharpe) === Math.sign(b) && Math.abs(p.sharpe) >= 0.5 * Math.abs(b)).length;
  return { base, stability: points.length ? stable / points.length : 0, points };
}
