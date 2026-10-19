import { RuleSchema, type LabDataset, type PerfStats, type Rule, type RuleEvaluation } from "../types.js";
import { concatReturns, equityCurve, perfStats, sharpeOf, simulate } from "./backtest.js";
import { checkDataset, makeCtx, rangeIndices, type EvalCtx } from "./context.js";
import { makeLabels } from "./labels.js";
import { ruleId, ruleText, zoneConditions } from "./rules.js";
import { deflatedSharpeOf } from "./stats.js";
import { verdictOf } from "./verdict.js";
import { isoDate, parseDay, SearchRefused } from "./util.js";
import { makeSplit, MIN_TRAIN_ROWS, positions, sensitivity, walkForwardSegments, type Split } from "./validate.js";

// Full evaluation of one rule (docs/LAB.md §6–8), shared by the search (top rules)
// and by explicit rule evaluation outside a search.

export interface EvalInCtxOptions {
  split: Split;
  labels: Float64Array;
  slippageBps: number;
  walkForward: boolean;
  /**
   * Walk-forward thresholds: true (a search's rule) refits them per fold by
   * quantile matching; false (an explicit rule) keeps them fixed. Default true.
   */
  refitThresholds?: boolean;
  /** N for the deflated Sharpe: effective independent trials of the search that found this rule. Default 1. */
  trials?: number;
  /** Configured windows; when set, a sensitivity grid is attached. */
  windows?: readonly number[];
  includeEquity?: boolean;
}

export function evaluateInCtx(ctx: EvalCtx, rule: Rule, o: EvalInCtxOptions): RuleEvaluation {
  const { n, t } = ctx;
  const { split } = o;
  const dirSign = rule.direction === "long" ? 1 : -1;
  const sig = ctx.signal(zoneConditions(rule));
  const pos = positions(sig, dirSign);
  const bench = new Float64Array(n).fill(dirSign);

  // Precision and support over labelled training days of the search region.
  let support = 0;
  let good = 0;
  for (let i = 0; i < split.basisEnd; i++) {
    const y = o.labels[i]!;
    if (y !== y || !sig[i]) continue;
    support++;
    if (y === 1) good++;
  }

  const inSeg = simulate(ctx.pr, pos, 1, split.searchEnd, o.slippageBps);
  const inBench = simulate(ctx.pr, bench, 1, split.searchEnd, o.slippageBps);
  const hasHoldout = n - split.searchEnd >= 2;
  const holdout = hasHoldout ? perfStats(t, [simulate(ctx.pr, pos, split.searchEnd, n, o.slippageBps)]) : null;
  const benchHoldout = hasHoldout ? perfStats(t, [simulate(ctx.pr, bench, split.searchEnd, n, o.slippageBps)]) : null;

  const values: Record<string, number | null> = {};
  for (const c of rule.conditions) {
    const x = ctx.col(c.feature)[n - 1]!;
    values[c.feature] = Number.isFinite(x) ? x : null;
  }
  const wf = o.walkForward && split.folds.length ? walkForwardSegments(ctx, zoneConditions(rule), split, dirSign, o.slippageBps, o.refitThresholds ?? true) : null;

  const out: RuleEvaluation = {
    id: ruleId(rule),
    rule,
    text: ruleText(rule),
    precision: support ? good / support : 0,
    support,
    inSample: perfStats(t, [inSeg]),
    walkForward: wf ? perfStats(t, wf) : null,
    // A block the rule never trades in is untested, not a Sharpe of 0.
    walkForwardFolds: wf ? wf.map((s) => (s.held.some((h) => h !== 0) ? sharpeOf(s.ret) : null)) : [],
    deflatedSharpe: wf ? deflatedSharpeOf(concatReturns(wf), o.trials ?? 1) : null,
    holdout,
    benchmark: { inSample: perfStats(t, [inBench]), holdout: benchHoldout },
    firingNow: sig[n - 1] === 1,
    latest: { date: isoDate(t[n - 1]!), values },
  };
  if (o.windows) {
    out.sensitivity = sensitivity(ctx, rule, { basisEnd: split.basisEnd, evalEnd: split.searchEnd, windows: o.windows, slippageBps: o.slippageBps });
  }
  if (o.includeEquity) {
    out.equity = equityCurve(t, simulate(ctx.pr, pos, 1, n, o.slippageBps), simulate(ctx.pr, bench, 1, n, o.slippageBps));
  }
  out.verdict = verdictOf(out);
  return out;
}

export interface EvaluateRuleOptions {
  slippageBps: number;
  includeEquity?: boolean;
  /** Evaluation range (YYYY-MM-DD). Features still warm up on earlier data. */
  from?: string;
  to?: string;
  /** Windows to swap in for the sensitivity grid; omitted = no sensitivity. */
  windows?: number[];
  /** Label quantile for precision; default 0.3. */
  labelQuantile?: number;
  /**
   * Walk-forward over `folds` blocks of the first 80%, the rule's absolute
   * thresholds fixed in every test block (nothing is refitted: the rule is
   * given, not searched). Default: on when the first fold has enough purged
   * training rows; true on too little history is refused.
   */
  walkForward?: boolean;
  /** Walk-forward folds; default 3. */
  folds?: number;
  /**
   * N for the deflated Sharpe: the effective trials of the search that found
   * the rule (SearchResult.effectiveTrials); default 1, i.e. not deflated for
   * any search.
   */
  trials?: number;
}

/**
 * Scores an explicit rule on a dataset: in-sample = first 80% of the range,
 * holdout = last 20%, walk-forward = the same fixed thresholds on each test
 * block of the first 80% (a search's rules instead refit per fold, search.ts).
 */
export function evaluateRule(input: Rule, data: LabDataset, opts: EvaluateRuleOptions): RuleEvaluation {
  const rule = RuleSchema.parse(input);
  checkDataset(data);
  const [lo, hi] = rangeIndices(data.t, opts.from, opts.to);
  const ctx = makeCtx(data, lo, hi);
  if (ctx.n < 10) throw new SearchRefused(`only ${ctx.n} days in range; need at least 10`, "from");
  const folds = opts.folds ?? 3;
  if (!Number.isInteger(folds) || folds < 2 || folds > 6) throw new SearchRefused("folds must be an integer from 2 to 6", "folds");
  const split = makeSplit(ctx.n, folds, rule.horizonDays);
  const canWalk = split.folds[0]!.purgedEnd >= MIN_TRAIN_ROWS;
  if (opts.walkForward && !canWalk) throw new SearchRefused(`${ctx.n} days is too short for walk-forward at a ${rule.horizonDays}-day horizon`, "from");
  const labels = makeLabels({
    t: ctx.t,
    price: ctx.price,
    horizonDays: rule.horizonDays,
    direction: rule.direction,
    quantile: opts.labelQuantile ?? 0.3,
    end: split.searchEnd,
  });
  return evaluateInCtx(ctx, rule, {
    split,
    labels,
    slippageBps: opts.slippageBps,
    walkForward: opts.walkForward ?? canWalk,
    refitThresholds: false,
    trials: opts.trials,
    windows: opts.windows,
    includeEquity: opts.includeEquity,
  });
}

/** Is the rule in zone on the last day of the data, and with what feature values. */
export function ruleFiresAt(input: Rule, data: LabDataset): { firing: boolean; latest: RuleEvaluation["latest"] } {
  const rule = RuleSchema.parse(input);
  checkDataset(data);
  if (!data.t.length) throw new Error("empty dataset");
  const ctx = makeCtx(data);
  const n = ctx.n;
  const sig = ctx.signal(zoneConditions(rule), n - 1, n);
  const values: Record<string, number | null> = {};
  for (const c of rule.conditions) {
    const x = ctx.col(c.feature)[n - 1]!;
    values[c.feature] = Number.isFinite(x) ? x : null;
  }
  return { firing: sig[n - 1] === 1, latest: { date: isoDate(ctx.t[n - 1]!), values } };
}

/** In-zone flag per day of data.t (for overlap / Jaccard). */
export function inZoneDays(input: Rule, data: LabDataset): boolean[] {
  const rule = RuleSchema.parse(input);
  checkDataset(data);
  return Array.from(makeCtx(data).signal(zoneConditions(rule)), (x) => x === 1);
}

export interface FunnelStep {
  condition: string;
  /** Coin-days (summed over coins) passing this condition and every one before it. */
  survivors: number;
  /** Relative drop from the previous step (the first step: from all coin-days); 0 when that was 0. */
  dropRel: number;
}

/** Where the idea dies: coin-days surviving each condition in rule order, via the same conditionSignal as evaluation. `bottleneck` = step with the largest dropRel (first on ties; -1 if none). */
export function funnel(input: Rule, data: LabDataset | LabDataset[]): { steps: FunnelStep[]; bottleneck: number } {
  const rule = RuleSchema.parse(input);
  const sets = Array.isArray(data) ? data : [data];
  const steps: FunnelStep[] = [];
  const ctxs = sets.map((d) => (checkDataset(d), makeCtx(d)));
  let prev = ctxs.reduce((a, c) => a + c.n, 0);
  const conds = zoneConditions(rule);
  conds.forEach((c, k) => {
    const sv = ctxs.reduce((a, ctx) => a + ctx.signal(conds.slice(0, k + 1)).reduce((x, v) => x + v, 0), 0);
    steps.push({ condition: ruleText({ conditions: [c] }), survivors: sv, dropRel: prev ? 1 - sv / prev : 0 });
    prev = sv;
  });
  let bottleneck = -1;
  steps.forEach((s, k) => {
    if (s.dropRel > (steps[bottleneck]?.dropRel ?? 0)) bottleneck = k;
  });
  return { steps, bottleneck };
}

/** Net performance over return days after `from` (a date or ISO time, e.g. savedAt); null with fewer than 2 return days. */
export function livePerf(input: Rule, data: LabDataset, opts: { slippageBps: number; from: string }): PerfStats | null {
  const rule = RuleSchema.parse(input);
  checkDataset(data);
  const start = /^\d{4}-\d{2}-\d{2}$/.test(opts.from) ? parseDay(opts.from) : Date.parse(opts.from);
  if (!Number.isFinite(start)) throw new Error(`invalid from "${opts.from}"`);
  const ctx = makeCtx(data);
  let a = ctx.t.findIndex((x) => x > start);
  if (a < 0 || ctx.n - a < 2) return null;
  a = Math.max(1, a);
  const pos = positions(ctx.signal(zoneConditions(rule), a - 1, ctx.n), rule.direction === "long" ? 1 : -1);
  return perfStats(ctx.t, [simulate(ctx.pr, pos, a, ctx.n, opts.slippageBps)]);
}
