// Rule search and evaluation. Pure, no I/O.
//
// Method (SPEC.md "Lab"):
// 1. Split the dated history: the last 20% is a holdout the search never
//    reads. The first 80% (train) is cut into 5 chronological folds.
// 2. A condition is (feature, <|>, quantile level). Its threshold is that
//    quantile of the data seen so far: walk-forward refits it on folds
//    [0, k) before trading fold k, so every walk-forward return is out of
//    fold. The reported rule uses the quantile of the whole train window.
// 3. Every single condition is scored on its walk-forward returns, net of
//    costs: mean of the per-fold Sharpes minus half their spread, so a rule
//    must work in every fold rather than ride one stretch. The best `beam`
//    singles are each ANDed with every other condition (a depth-2 tree
//    path); a pair survives only if it beats both parents.
// 4. Finalists get in-sample, walk-forward and holdout stats, a threshold
//    sensitivity check (neighbouring quantile levels) and a deflated Sharpe
//    that charges for every variant scored.
import {
  describeRule,
  LAB_BASES,
  parseFeatureId,
  type LabCondition,
  type LabRule,
  type LabRuleReport,
  type LabSearchOptions,
  type LabSearchResult,
  type LabStats,
} from "../../shared/lab.js";
import { dailyReturns, equityCurve, moments, quickScore, strategyReturns, windowStats, type ScoreLimits } from "./backtest.js";
import { buildFeatures, computeFeature, dayStart, isoDay, type LabDataset } from "./features.js";
import { deflatedSharpe, quantile, quantileSorted } from "./stats.js";

export const Q_LEVELS = [0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95];
export const HOLDOUT_FRAC = 0.2;
export const FOLDS = 5;
export const BEAM: Record<LabSearchOptions["effort"], number> = { quick: 12, standard: 30, deep: 60 };
/** Under two years of decision days the folds are too short to mean anything. */
export const MIN_DAYS = 730;
const DEFAULT_FROM = "2015-01-01";
const MAX_PER_ANCHOR = 2;
const DEFAULT_BUDGET_MS = 45_000;

export class LabError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LabError";
  }
}

export interface Split {
  r: Float64Array;
  start: number;
  /** Exclusive end of decision days: the last day has no next return to earn. */
  end: number;
  trainEnd: number;
  /** Fold starts within [start, trainEnd); folds[0] === start. */
  folds: number[];
  last: number;
}

const firstFinite = (x: Float64Array) => {
  for (let i = 0; i < x.length; i++) if (Number.isFinite(x[i]!)) return i;
  return -1;
};

export function split(ds: LabDataset, from: string | undefined, earliestFeature: number): Split {
  const T = ds.days.length;
  let last = T - 1;
  while (last >= 0 && !Number.isFinite(ds.close[last]!)) last--;
  const px = firstFinite(ds.close);
  if (px < 0 || last < 0) throw new LabError("no price history");
  const fromMs = Date.parse(`${from ?? DEFAULT_FROM}T00:00:00Z`);
  const fromIdx = Math.max(0, ds.days.findIndex((d) => d >= dayStart(fromMs)));
  const start = Math.max(px + 1, fromIdx, earliestFeature);
  const end = last; // decision days [start, last): day `last` has no t+1 return yet
  if (end - start < MIN_DAYS) {
    throw new LabError(`need at least ${MIN_DAYS} days of overlapping price and feature history, have ${Math.max(0, end - start)}`);
  }
  const trainEnd = start + Math.floor((end - start) * (1 - HOLDOUT_FRAC));
  const folds = Array.from({ length: FOLDS }, (_, k) => start + Math.floor((k * (trainEnd - start)) / FOLDS));
  return { r: dailyReturns(ds.close), start, end, trainEnd, folds, last };
}

function limits(years: number): ScoreLimits {
  return { minExposure: 0.05, maxExposure: 0.95, minTrades: Math.max(3, Math.ceil(years / 2)) };
}

function fill(values: Float64Array, op: "<" | ">", thr: number, a: number, b: number, out: Uint8Array) {
  for (let t = a; t < b; t++) {
    const v = values[t]!;
    out[t] = Number.isFinite(v) && (op === "<" ? v < thr : v > thr) ? 1 : 0;
  }
}

/** Per-fold thresholds for a quantile level: fold k (k >= 1) uses data in [start, folds[k]). */
function foldThresholds(sortedPrefixes: number[][], q: number): number[] {
  return sortedPrefixes.map((s) => quantileSorted(s, q));
}

function sortedFinite(x: Float64Array, a: number, b: number): number[] {
  const out: number[] = [];
  for (let t = a; t < b; t++) if (Number.isFinite(x[t]!)) out.push(x[t]!);
  return out.sort((p, q) => p - q);
}

interface Cond {
  fi: number;
  op: "<" | ">";
  qi: number;
  thr: number;
  sigTrain: Uint8Array;
  sigWF: Uint8Array;
  sr: number;
  score: number;
}

const condKey = (fi: number, op: string, qi: number) => `${fi}${op}${qi}`;

/** sigWF for one (feature, op, q): fold k traded with the threshold fit on folds before it. */
function wfSignal(values: Float64Array, op: "<" | ">", thrs: number[], sp: Split, out: Uint8Array) {
  for (let k = 1; k < FOLDS; k++) {
    const a = sp.folds[k]!;
    const b = k + 1 < FOLDS ? sp.folds[k + 1]! : sp.trainEnd;
    const thr = thrs[k]!;
    if (Number.isFinite(thr)) fill(values, op, thr, a, b, out);
  }
}

function and(sigs: Uint8Array[], a: number, b: number, out: Uint8Array) {
  out.fill(0);
  for (let t = a; t < b; t++) {
    let v = 1;
    for (const s of sigs) v &= s[t]!;
    out[t] = v;
  }
}

export function runSearch(ds: LabDataset, opts: LabSearchOptions, nowMs = Date.now, budgetMs = DEFAULT_BUDGET_MS): LabSearchResult {
  const t0 = nowMs();
  const warnings: string[] = [];
  const requested = opts.bases ?? LAB_BASES.map((b) => b.id);
  const baseIds = requested.filter((id) => ds.bases[id]?.some(Number.isFinite));
  const missing = requested.filter((id) => !baseIds.includes(id));
  if (missing.length) warnings.push(`no data for ${missing.join(", ")}`);
  if (baseIds.length === 0) throw new LabError("none of the requested base series has data");

  const fm = buildFeatures(ds, baseIds, opts.transforms);
  if (fm.ids.length === 0) throw new LabError("no features could be computed");
  const earliest = Math.min(...fm.values.map(firstFinite).filter((i) => i >= 0));
  const sp = split(ds, opts.from, earliest);
  const T = ds.days.length;
  const cost = opts.costBps / 10_000;
  const f1 = sp.folds[1]!;
  const trainYears = (sp.trainEnd - sp.start) / 365;
  const wfLim = limits((sp.trainEnd - f1) / 365);
  /** Fold starts inside the walk-forward window, for the consistency score. */
  const wfBounds = sp.folds.slice(1);
  let trials = 0;

  // ── single conditions ──
  const conds: Cond[] = [];
  const byKey = new Map<string, Cond>();
  for (let fi = 0; fi < fm.ids.length; fi++) {
    const x = fm.values[fi]!;
    const train = sortedFinite(x, sp.start, sp.trainEnd);
    if (train.length < (sp.trainEnd - sp.start) * 0.3) continue; // feature barely exists in train
    const prefixes = sp.folds.map((f) => sortedFinite(x, sp.start, f));
    for (let qi = 0; qi < Q_LEVELS.length; qi++) {
      const q = Q_LEVELS[qi]!;
      const thr = quantileSorted(train, q);
      if (qi > 0 && thr === quantileSorted(train, Q_LEVELS[qi - 1]!)) continue; // discrete feature, same cut
      const thrs = foldThresholds(prefixes, q);
      for (const op of ["<", ">"] as const) {
        const sigTrain = new Uint8Array(T);
        fill(x, op, thr, 0, T, sigTrain);
        const sigWF = new Uint8Array(T);
        wfSignal(x, op, thrs, sp, sigWF);
        const s = quickScore(sigWF, sp.r, opts.direction, cost, f1, sp.trainEnd, wfLim, wfBounds);
        trials++;
        const c: Cond = { fi, op, qi, thr, sigTrain, sigWF, sr: s.sr, score: s.score };
        conds.push(c);
        byKey.set(condKey(fi, op, qi), c);
      }
    }
  }

  // ── depth-2 beam ──
  type Cand = { conds: Cond[]; sr: number; score: number };
  const singles = conds.filter((c) => Number.isFinite(c.score)).sort((a, b) => b.score - a.score);
  const cands: Cand[] = singles.map((c) => ({ conds: [c], sr: c.sr, score: c.score }));
  const beam = singles.slice(0, BEAM[opts.effort]);
  const scratch = new Uint8Array(T);
  const seen = new Set<string>();
  outer: for (const c1 of beam) {
    for (const c2 of conds) {
      if (c2.fi === c1.fi) continue;
      if (nowMs() - t0 > budgetMs) {
        warnings.push("search budget reached; pair scan stopped early");
        break outer;
      }
      const k1 = condKey(c1.fi, c1.op, c1.qi);
      const k2 = condKey(c2.fi, c2.op, c2.qi);
      const key = k1 < k2 ? `${k1}&${k2}` : `${k2}&${k1}`;
      if (seen.has(key)) continue;
      seen.add(key);
      and([c1.sigWF, c2.sigWF], f1, sp.trainEnd, scratch);
      const s = quickScore(scratch, sp.r, opts.direction, cost, f1, sp.trainEnd, wfLim, wfBounds);
      trials++;
      if (!Number.isFinite(s.score)) continue;
      if (s.score > c1.score && s.score > (Number.isFinite(c2.score) ? c2.score : -Infinity)) cands.push({ conds: [c1, c2], sr: s.sr, score: s.score });
    }
  }

  // ── finalists: best per (features, ops) family, and no single condition
  // anchoring more than MAX_PER_ANCHOR of them, so one strong condition
  // paired with ten passengers does not fill the whole list ──
  cands.sort((a, b) => b.score - a.score);
  const families = new Set<string>();
  const anchors = new Map<string, number>();
  const finalists: Cand[] = [];
  for (const c of cands) {
    const fam = c.conds.map((x) => `${fm.ids[x.fi]}${x.op}`).sort().join("&");
    if (families.has(fam)) continue;
    const keys = c.conds.map((x) => condKey(x.fi, x.op, x.qi));
    if (keys.some((k) => (anchors.get(k) ?? 0) >= MAX_PER_ANCHOR)) continue;
    families.add(fam);
    for (const k of keys) anchors.set(k, (anchors.get(k) ?? 0) + 1);
    finalists.push(c);
    if (finalists.length >= opts.maxResults) break;
  }
  if (finalists.length === 0) warnings.push("no rule met the exposure and trade-count limits");

  const results = finalists.map((c) => {
    const conditions = c.conds.map((x) => ({ feature: fm.ids[x.fi]!, op: x.op, q: Q_LEVELS[x.qi]!, threshold: x.thr }));
    const rule = { direction: opts.direction, conditions };
    const sigTrain = new Uint8Array(T);
    and(c.conds.map((x) => x.sigTrain), 0, T, sigTrain);
    const sigWF = new Uint8Array(T);
    and(c.conds.map((x) => x.sigWF), f1, sp.trainEnd, sigWF);

    // Sensitivity: move one condition's quantile one step either way.
    const neighbours: number[] = [];
    c.conds.forEach((x, i) => {
      for (const d of [-1, 1]) {
        const n = byKey.get(condKey(x.fi, x.op, x.qi + d));
        if (!n) continue;
        const sigs = c.conds.map((y, j) => (j === i ? n.sigWF : y.sigWF));
        and(sigs, f1, sp.trainEnd, scratch);
        const s = quickScore(scratch, sp.r, opts.direction, cost, f1, sp.trainEnd, { minExposure: 0, maxExposure: 1, minTrades: 0 });
        neighbours.push(Number.isFinite(s.sr) ? s.sr : 0);
      }
    });
    const stability = neighbours.length && c.sr > 0 ? Math.min(...neighbours) / c.sr : null;

    const wfRet = strategyReturns(sigWF, sp.r, opts.direction, cost, f1, sp.trainEnd);
    const { skew, kurt } = moments(wfRet);
    // Trial dispersion under the null: Var(SR) ~ 1/(T-1). The empirical spread
    // of trial Sharpes would also count real signal and the heavy overlap
    // between variants, which inflates the bar for exactly the rules that work.
    const nullVar = 1 / Math.max(1, wfRet.length - 1);
    return buildReport(rule, sigTrain, sigWF, sp, ds, opts.direction, cost, {
      deflatedSharpe: deflatedSharpe(c.sr, wfRet.length, skew, kurt, trials, nullVar),
      stability,
    });
  });

  if (trainYears < 4) warnings.push(`train window is ${trainYears.toFixed(1)} years; treat results as exploratory`);
  return {
    request: opts,
    generatedAt: new Date(nowMs()).toISOString(),
    range: { from: isoDay(ds.days[sp.start]!), to: isoDay(ds.days[sp.last]!), trainEnd: isoDay(ds.days[sp.trainEnd]!) },
    bases: baseIds,
    features: fm.ids.length,
    trials,
    elapsedMs: nowMs() - t0,
    results,
    warnings,
  };
}

function buildReport(
  rule: LabRuleReport["rule"],
  sigTrain: Uint8Array,
  sigWF: Uint8Array | null,
  sp: Split,
  ds: LabDataset,
  dir: LabRule["direction"],
  cost: number,
  extra: { deflatedSharpe: number | null; stability: number | null },
): LabRuleReport {
  const f1 = sp.folds[1]!;
  return {
    rule,
    text: describeRule(rule),
    inSample: windowStats(sigTrain, sp.r, dir, cost, sp.start, sp.trainEnd, ds.days),
    walkForward: sigWF ? windowStats(sigWF, sp.r, dir, cost, f1, sp.trainEnd, ds.days) : null,
    outOfSample: sp.end - sp.trainEnd >= 2 ? windowStats(sigTrain, sp.r, dir, cost, sp.trainEnd, sp.end, ds.days) : null,
    deflatedSharpe: extra.deflatedSharpe,
    stability: extra.stability,
    firingNow: sigTrain[sp.last] === 1,
    asOf: isoDay(ds.days[sp.last]!),
    equity: equityCurve(sigTrain, sp.r, dir, cost, sp.start, sp.end, ds.days),
  };
}

function ruleFeatures(ds: LabDataset, rule: LabRule): Float64Array[] {
  return rule.conditions.map((c) => {
    const p = parseFeatureId(c.feature);
    if (!p || !ds.bases[p.base.id]?.some(Number.isFinite)) throw new LabError(`no data for ${c.feature}`);
    const v = computeFeature(ds, c.feature);
    if (!v) throw new LabError(`unknown feature ${c.feature}`);
    return v;
  });
}

/**
 * Evaluates a given rule on the same split a search would use. Conditions
 * with `q` resolve to the train-window quantile (and get a walk-forward run);
 * conditions with only `threshold` are fixed, so walk-forward is skipped.
 */
export function evaluateRule(ds: LabDataset, rule: LabRule, opts: { from?: string; costBps?: number } = {}): LabRuleReport {
  const values = ruleFeatures(ds, rule);
  const earliest = Math.max(...values.map(firstFinite));
  if (earliest < 0) throw new LabError("rule features have no history");
  const sp = split(ds, opts.from, earliest);
  const T = ds.days.length;
  const cost = (opts.costBps ?? 10) / 10_000;
  const allQ = rule.conditions.every((c) => c.q !== undefined && c.threshold === undefined);

  const resolved = rule.conditions.map((c, i) => ({
    ...c,
    threshold: c.threshold ?? quantile(values[i]!, sp.start, sp.trainEnd, c.q!),
  }));
  const sigs = resolved.map((c, i) => {
    const s = new Uint8Array(T);
    fill(values[i]!, c.op, c.threshold, 0, T, s);
    return s;
  });
  const sigTrain = new Uint8Array(T);
  and(sigs, 0, T, sigTrain);

  let sigWF: Uint8Array | null = null;
  let dsr: number | null = null;
  if (allQ) {
    const wfs = resolved.map((c, i) => {
      const prefixes = sp.folds.map((f) => sortedFinite(values[i]!, sp.start, f));
      const out = new Uint8Array(T);
      wfSignal(values[i]!, c.op, foldThresholds(prefixes, c.q!), sp, out);
      return out;
    });
    sigWF = new Uint8Array(T);
    and(wfs, sp.folds[1]!, sp.trainEnd, sigWF);
    // One rule, one trial: the deflated Sharpe reduces to the probabilistic Sharpe vs 0.
    const ret = strategyReturns(sigWF, sp.r, rule.direction, cost, sp.folds[1]!, sp.trainEnd);
    const { skew, kurt } = moments(ret);
    const q = quickScore(sigWF, sp.r, rule.direction, cost, sp.folds[1]!, sp.trainEnd, { minExposure: 0, maxExposure: 1, minTrades: 0 });
    dsr = Number.isFinite(q.sr) ? deflatedSharpe(q.sr, ret.length, skew, kurt, 1, 0) : null;
  }
  return buildReport({ direction: rule.direction, conditions: resolved }, sigTrain, sigWF, sp, ds, rule.direction, cost, {
    deflatedSharpe: dsr,
    stability: null,
  });
}

/**
 * Catalogue re-check: the rule's saved absolute thresholds on today's data.
 * `sinceSaved` covers only days after the rule was saved — data that could
 * not have shaped it.
 */
export function liveCheck(
  ds: LabDataset,
  rule: LabRuleReport["rule"],
  savedAt: string,
  costBps = 10,
): { firingNow: boolean; asOf: string; sinceSaved: LabStats | null; full: LabStats } {
  const values = ruleFeatures(ds, rule);
  const T = ds.days.length;
  const sigs = rule.conditions.map((c: LabCondition & { threshold: number }, i) => {
    const s = new Uint8Array(T);
    fill(values[i]!, c.op, c.threshold, 0, T, s);
    return s;
  });
  const sig = new Uint8Array(T);
  and(sigs, 0, T, sig);
  const r = dailyReturns(ds.close);
  let last = T - 1;
  while (last >= 0 && !Number.isFinite(ds.close[last]!)) last--;
  const start = Math.max(1, Math.max(...values.map(firstFinite)));
  const cost = costBps / 10_000;
  const savedIdx = ds.days.findIndex((d) => d >= dayStart(Date.parse(savedAt)));
  return {
    firingNow: sig[last] === 1,
    asOf: isoDay(ds.days[last]!),
    full: windowStats(sig, r, rule.direction, cost, start, last, ds.days),
    sinceSaved: savedIdx >= 0 && last - savedIdx >= 2 ? windowStats(sig, r, rule.direction, cost, savedIdx, last, ds.days) : null,
  };
}
