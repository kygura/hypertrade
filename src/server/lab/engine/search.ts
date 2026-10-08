import { SearchConfigSchema, type Condition, type LabDataset, type Rule, type SearchConfig, type SearchResult, type TrialRecord } from "../types.js";
import { objectiveOf, quickScore, simulate } from "./backtest.js";
import { checkDataset, makeCtx, rangeIndices } from "./context.js";
import { evaluateInCtx } from "./evaluate.js";
import { featureId, featureSpecs } from "./features.js";
import { makeLabels } from "./labels.js";
import { fork, gauss, mulberry32, randInt, type Rng } from "./rng.js";
import { conditionsKey, extractRules } from "./rules.js";
import { binFeatures, growForest, type Binned, type TreeParams } from "./tree.js";
import { isoDate } from "./util.js";
import { makeSplit, walkForwardScore, walkForwardSegments } from "./validate.js";

// The heuristic search (LAB.md §4–7). Each trial grows a forest per
// walk-forward fold on the purged training rows, takes the best rules by
// training objective, trades them on the fold's test block, and is scored on
// the concatenated test blocks. The best trial's parameters are refitted on
// the whole search region; its rules are ranked by quantile-matched
// walk-forward objective and only then scored on the holdout.

export const MAX_FEATURES = 600;
export const MIN_PRICE_DAYS = 365;
/** Minimum purged training rows in the first fold. */
const MIN_TRAIN_ROWS = 60;
/** Rules blended per fold when scoring a trial. */
const BLEND = 3;
/** Final candidates scored walk-forward (cost bound). */
const MAX_CANDIDATES = 400;

export interface SearchOptions {
  /** Stop starting trials once this much time has passed; still returns. */
  deadlineMs?: number;
  now?: () => number;
  onProgress?: (trialsDone: number) => void;
}

interface TrainSet {
  rows: Int32Array;
  binned: Binned;
  minSupport: number;
  /** Return days [1, retEnd) score rules on this training set. */
  retEnd: number;
  /** Rule key → {signal, support, objective}, reused across trials (binning is fixed per fold). */
  cache: Map<string, { sig: Uint8Array; support: number; score: number }>;
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

function sampleParams(rng: Rng): TreeParams {
  return {
    featureFrac: r3(0.05 + rng() * 0.45),
    minLeaf: Math.round(Math.exp(Math.log(10) + rng() * Math.log(15))),
    bootstrapFrac: r3(0.4 + rng() * 0.6),
    trees: randInt(rng, 10, 60),
  };
}

function perturb(p: TreeParams, rng: Rng): TreeParams {
  return {
    featureFrac: r3(clamp(p.featureFrac * Math.exp(0.3 * gauss(rng)), 0.03, 0.8)),
    minLeaf: Math.round(clamp(p.minLeaf * Math.exp(0.3 * gauss(rng)), 5, 200)),
    bootstrapFrac: r3(clamp(p.bootstrapFrac + 0.1 * gauss(rng), 0.3, 1)),
    trees: Math.round(clamp(p.trees * Math.exp(0.25 * gauss(rng)), 5, 100)),
  };
}

export function runSearch(input: SearchConfig, data: LabDataset, opts: SearchOptions = {}): SearchResult {
  const now = opts.now ?? Date.now;
  const started = now();
  const config = SearchConfigSchema.parse(input);
  checkDataset(data);
  const warnings: string[] = [];

  const metrics = [...new Set(config.metrics)].filter((m) => {
    if (data.metrics[m]) return true;
    warnings.push(`metric ${m} has no data for ${config.asset}; skipped`);
    return false;
  });
  if (!metrics.length) throw new Error("none of the requested metrics has data");
  const specs = featureSpecs(metrics, config.transforms, config.windows);
  if (specs.length > MAX_FEATURES) {
    throw new Error(`${specs.length} features exceed the cap of ${MAX_FEATURES}: use fewer metrics, transforms or windows`);
  }

  const [lo, hi] = rangeIndices(data.t, config.from, config.to);
  const ctx = makeCtx(data, lo, hi);
  const n = ctx.n;
  let priceDays = 0;
  for (const p of ctx.price) if (p > 0) priceDays++;
  if (priceDays < MIN_PRICE_DAYS) throw new Error(`price history has ${priceDays} days; a search needs at least ${MIN_PRICE_DAYS}`);

  const split = makeSplit(n, config.folds, config.horizonDays);
  if (split.folds[0]!.purgedEnd < MIN_TRAIN_ROWS) {
    throw new Error(`${n} days is too short for ${config.folds} folds at a ${config.horizonDays}-day horizon; use fewer folds, a shorter horizon or more history`);
  }
  const labels = makeLabels({
    t: ctx.t,
    price: ctx.price,
    horizonDays: config.horizonDays,
    direction: config.direction,
    quantile: config.labelQuantile,
    end: split.searchEnd,
    customZones: config.customZones,
  });

  // Features with too little history in the search region cannot split.
  const ids: string[] = [];
  const cols: Float64Array[] = [];
  let dropped = 0;
  for (const s of specs) {
    const id = featureId(s);
    const c = ctx.col(id);
    let k = 0;
    for (let i = 0; i < split.basisEnd; i++) if (c[i] === c[i]) k++;
    if (k >= 30) {
      ids.push(id);
      cols.push(c);
    } else dropped++;
  }
  if (dropped) warnings.push(`${dropped} of ${specs.length} features have under 30 values in the search region; dropped`);
  if (!ids.length) throw new Error("no feature has enough history in the search region");

  const dirSign = config.direction === "long" ? 1 : -1;
  const bps = config.slippageBps;
  const objective = config.objective;

  const trainSet = (end: number, retEnd: number, baseRows?: number): TrainSet => {
    const list: number[] = [];
    for (let i = 0; i < end; i++) if (labels[i] === labels[i]) list.push(i);
    const rows = Int32Array.from(list);
    const minSupport = baseRows ? Math.max(5, Math.round((config.minSupport * rows.length) / baseRows)) : config.minSupport;
    return { rows, binned: binFeatures(cols, rows), minSupport, retEnd, cache: new Map() };
  };
  const final = trainSet(split.basisEnd, split.searchEnd);
  let positives = 0;
  for (const r of final.rows) if (labels[r] === 1) positives++;
  if (!positives) throw new Error("no day in the search region is labelled good; widen labelQuantile or check customZones");
  if (positives === final.rows.length) throw new Error("every day in the search region is labelled good; nothing to separate");
  const folds = split.folds.map((f) => ({ fold: f, train: trainSet(f.purgedEnd, f.testFrom, final.rows.length) }));

  /** Rules with their signal, support and training objective, support-filtered, best first. */
  const scoreRules = (ts: TrainSet, rules: Condition[][]) => {
    const out: Array<{ key: string; conds: Condition[]; sig: Uint8Array; score: number }> = [];
    for (const conds of rules) {
      const key = conditionsKey(conds);
      let e = ts.cache.get(key);
      if (!e) {
        const sig = ctx.signal(conds);
        let support = 0;
        for (const r of ts.rows) support += sig[r]!;
        const score = support >= ts.minSupport ? quickScore(ctx.pr, sig, dirSign, bps, 1, ts.retEnd, objective) : NaN;
        e = { sig, support, score };
        if (ts.cache.size < 20_000) ts.cache.set(key, e);
      }
      if (e.score === e.score) out.push({ key, conds, sig: e.sig, score: e.score });
    }
    out.sort((a, b) => b.score - a.score || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return out;
  };

  const scoreTrial = (params: TreeParams, rng: Rng) => {
    const rets: number[] = [];
    let rules = 0;
    for (const { fold, train } of folds) {
      const forest = growForest(train.binned, labels, train.rows, params, rng);
      const ranked = scoreRules(train, extractRules(forest, ids));
      rules += ranked.length;
      // Blend the best few rules with a positive training objective; none = flat.
      const picks = ranked.filter((r) => r.score > 0).slice(0, BLEND);
      const pos = new Float64Array(n);
      for (const p of picks) for (let i = fold.testFrom - 1; i < fold.testTo; i++) pos[i] += (p.sig[i]! * dirSign) / picks.length;
      const seg = simulate(ctx.pr, pos, fold.testFrom, fold.testTo, bps);
      for (const r of seg.ret) rets.push(r);
    }
    return { score: objectiveOf(rets, objective), rules };
  };

  const rng = mulberry32(config.seed);
  const trials: TrialRecord[] = [];
  let best: TrialRecord | null = null;
  const half = Math.ceil(config.trials / 2);
  for (let i = 0; i < config.trials; i++) {
    if (i > 0 && opts.deadlineMs != null && now() - started >= opts.deadlineMs) {
      warnings.push(`deadline of ${opts.deadlineMs} ms reached after ${i} of ${config.trials} trials; results use the completed trials`);
      break;
    }
    const params = i < half || !best ? sampleParams(rng) : perturb(best.params, rng);
    const { score, rules } = scoreTrial(params, fork(rng));
    const rec: TrialRecord = { trial: i, params, score: Number.isFinite(score) ? score : 0, rules };
    trials.push(rec);
    if (!best || rec.score > best.score) best = rec;
    opts.onProgress?.(i + 1);
  }

  // Refit the best parameters on the whole search region, then rank its
  // rules by quantile-matched walk-forward objective (never by holdout).
  const forest = growForest(final.binned, labels, final.rows, { ...best!.params, trees: Math.max(100, best!.params.trees) }, mulberry32((config.seed ^ 0x5bd1e995) >>> 0));
  const candidates = scoreRules(final, extractRules(forest, ids))
    .slice(0, MAX_CANDIDATES)
    .map((c) => ({ ...c, wf: walkForwardScore(walkForwardSegments(ctx, c.conds, split, dirSign, bps), objective) }))
    .sort((a, b) => b.wf - a.wf || a.conds.length - b.conds.length || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  // Rules with identical in-zone days are one rule; keep the best-ranked.
  const seen = new Set<number>();
  const top: typeof candidates = [];
  for (const c of candidates) {
    const h = sigHash(c.sig);
    if (seen.has(h)) continue;
    seen.add(h);
    top.push(c);
    if (top.length >= config.topK) break;
  }
  if (!top.length) warnings.push(`no rule reached minSupport ${config.minSupport} in the search region`);
  const rules = top.map((c) => {
    const rule: Rule = { asset: config.asset, direction: config.direction, horizonDays: config.horizonDays, conditions: c.conds };
    if (config.price) rule.price = config.price;
    return evaluateInCtx(ctx, rule, { split, labels, slippageBps: bps, walkForward: true, windows: config.windows });
  });

  const total = forest.importance.reduce((a, b) => a + b, 0);
  const featureImportance = Array.from(forest.importance, (score, i) => ({ feature: ids[i]!, score: total > 0 ? r3(score / total) : 0 }))
    .filter((f) => f.score > 0)
    .sort((a, b) => b.score - a.score || (a.feature < b.feature ? -1 : 1))
    .slice(0, 30);

  return {
    config,
    dataRange: { from: isoDate(ctx.t[0]!), to: isoDate(ctx.t[n - 1]!), days: n, holdoutFrom: isoDate(ctx.t[split.searchEnd]!) },
    featureCount: ids.length,
    trialsRun: trials.length,
    bestTrial: best,
    trials,
    rules,
    featureImportance,
    warnings,
    durationMs: now() - started,
  };
}

/** FNV-1a over the signal bytes. */
function sigHash(sig: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < sig.length; i++) h = Math.imul(h ^ sig[i]!, 0x01000193) >>> 0;
  return h;
}
