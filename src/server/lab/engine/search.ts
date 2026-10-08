import { SearchConfigSchema, type Condition, type LabDataset, type Rule, type SearchConfig, type SearchResult, type TrialRecord } from "../types.js";
import { concatReturns, objectiveOf, quickScore, simulate, zoneActivity } from "./backtest.js";
import { checkDataset, makeCtx, rangeIndices } from "./context.js";
import { evaluateInCtx } from "./evaluate.js";
import { featureId, featureSpecs } from "./features.js";
import { makeLabels, type LabelOptions } from "./labels.js";
import { fork, gauss, mulberry32, randInt, type Rng } from "./rng.js";
import { conditionsKey, extractRules } from "./rules.js";
import { deflatedSharpeOf } from "./stats.js";
import { binFeatures, growForest, type Binned, type TreeParams } from "./tree.js";
import { isoDate, SearchRefused } from "./util.js";
import { makeSplit, MIN_TRAIN_ROWS, walkForwardScore, walkForwardSegments, type Split } from "./validate.js";

// The heuristic search (LAB.md §4–7). Each trial grows a forest per
// walk-forward fold on the purged training rows, takes the best rules by
// training objective, trades them on the fold's test block, and is scored on
// the concatenated test blocks. The best trial's parameters are refitted on
// the whole search region; its rules are ranked by quantile-matched
// walk-forward objective and only then scored on the holdout.

export const MAX_FEATURES = 600;
export const MIN_PRICE_DAYS = 365;
/** Rules blended per fold when scoring a trial. */
const BLEND = 3;
/** Final candidates scored walk-forward (cost bound). */
const MAX_CANDIDATES = 400;
/** Final rules whose in-sample in-zone days overlap this much are one family. */
const FAMILY_JACCARD = 0.8;
/** At most this many final rules share one exact condition. */
const MAX_PER_ANCHOR = 2;

export interface SearchOptions {
  /** Stop starting trials once this much time has passed; still returns. */
  deadlineMs?: number;
  now?: () => number;
  onProgress?: (trialsDone: number) => void;
}

interface TrainSet {
  rows: Int32Array;
  /** Labels of this training set (threshold from its own rows only). */
  labels: Float64Array;
  binned: Binned;
  minSupport: number;
  /** Return days [1, retEnd) score rules on this training set. */
  retEnd: number;
  /** Fewest trades entered over those days (exposure/trade limits). */
  minTrades: number;
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

/**
 * Labels for the final refit (quantile over the search region) and for each
 * walk-forward fold (quantile over that fold's training region only, whose
 * forward windows end at the test block's edge), so no fold's labels see the
 * forward returns of a later test block.
 */
export function splitLabels(o: Omit<LabelOptions, "end">, split: Split): { final: Float64Array; folds: Float64Array[] } {
  return { final: makeLabels({ ...o, end: split.searchEnd }), folds: split.folds.map((f) => makeLabels({ ...o, end: f.testFrom })) };
}

export function runSearch(input: SearchConfig, data: LabDataset, opts: SearchOptions = {}): SearchResult {
  const now = opts.now ?? Date.now;
  const started = now();
  const config = SearchConfigSchema.parse(input);
  checkDataset(data);
  if (config.minExposure > config.maxExposure) throw new SearchRefused("minExposure is above maxExposure", "minExposure");
  const warnings: string[] = [];

  const metrics = [...new Set(config.metrics)].filter((m) => {
    if (data.metrics[m]) return true;
    warnings.push(`metric ${m} has no data for ${config.asset}; skipped`);
    return false;
  });
  if (!metrics.length) throw new SearchRefused("none of the requested metrics has data", "metrics");
  const specs = featureSpecs(metrics, config.transforms, config.windows, data.stationary);
  if (specs.length > MAX_FEATURES) {
    throw new SearchRefused(`${specs.length} features exceed the cap of ${MAX_FEATURES}: use fewer metrics, transforms or windows`, "metrics");
  }

  const [lo, hi] = rangeIndices(data.t, config.from, config.to);
  const ctx = makeCtx(data, lo, hi);
  const n = ctx.n;
  let priceDays = 0;
  for (const p of ctx.price) if (p > 0) priceDays++;
  if (priceDays < MIN_PRICE_DAYS) throw new SearchRefused(`price history has ${priceDays} days; a search needs at least ${MIN_PRICE_DAYS}`, "from");

  const split = makeSplit(n, config.folds, config.horizonDays);
  if (split.folds[0]!.purgedEnd < MIN_TRAIN_ROWS) {
    throw new SearchRefused(`${n} days is too short for ${config.folds} folds at a ${config.horizonDays}-day horizon; use fewer folds, a shorter horizon or more history`, "folds");
  }
  const { final: labels, folds: foldLabels } = splitLabels(
    { t: ctx.t, price: ctx.price, horizonDays: config.horizonDays, direction: config.direction, quantile: config.labelQuantile, customZones: config.customZones },
    split,
  );

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
  if (!ids.length) throw new SearchRefused("no feature has enough history in the search region", "metrics");

  const dirSign = config.direction === "long" ? 1 : -1;
  const bps = config.slippageBps;
  const objective = config.objective;

  const trainSet = (end: number, retEnd: number, y: Float64Array, baseRows?: number): TrainSet => {
    const list: number[] = [];
    for (let i = 0; i < end; i++) if (y[i] === y[i]) list.push(i);
    const rows = Int32Array.from(list);
    const minSupport = baseRows ? Math.max(5, Math.round((config.minSupport * rows.length) / baseRows)) : config.minSupport;
    const minTrades = Math.max(3, Math.ceil((config.minTradesPerYear * (retEnd - 1)) / 365));
    return { rows, labels: y, binned: binFeatures(cols, rows), minSupport, retEnd, minTrades, cache: new Map() };
  };
  const final = trainSet(split.basisEnd, split.searchEnd, labels);
  let positives = 0;
  for (const r of final.rows) if (labels[r] === 1) positives++;
  if (!positives) throw new SearchRefused("no day in the search region is labelled good; widen labelQuantile or check customZones", config.customZones?.length ? "customZones" : "labelQuantile");
  if (positives === final.rows.length) throw new SearchRefused("every day in the search region is labelled good; nothing to separate", config.customZones?.length ? "customZones" : "labelQuantile");
  const folds = split.folds.map((f, k) => ({ fold: f, train: trainSet(f.purgedEnd, f.testFrom, foldLabels[k]!, final.rows.length) }));

  /** Exposure and trade-count limits over the training set's return days: a rule that is almost never or almost always in, or trades twice, is not a rule. */
  const withinLimits = (sig: Uint8Array, ts: TrainSet) => {
    const { exposure, trades } = zoneActivity(sig, 1, ts.retEnd);
    return exposure >= config.minExposure && exposure <= config.maxExposure && trades >= ts.minTrades;
  };
  /** Distinct rule variants scored anywhere in this search: N for the deflated Sharpe. */
  const scored = new Set<string>();
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
        const score = support >= ts.minSupport && withinLimits(sig, ts) ? quickScore(ctx.pr, sig, dirSign, bps, 1, ts.retEnd, objective) : NaN;
        e = { sig, support, score };
        if (ts.cache.size < 20_000) ts.cache.set(key, e);
      }
      if (e.score === e.score) {
        scored.add(key);
        out.push({ key, conds, sig: e.sig, score: e.score });
      }
    }
    out.sort((a, b) => b.score - a.score || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return out;
  };

  const scoreTrial = (params: TreeParams, rng: Rng) => {
    const rets: number[] = [];
    let rules = 0;
    for (const { fold, train } of folds) {
      const forest = growForest(train.binned, train.labels, train.rows, params, rng);
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
  // At least 100 trees: more trees only widen the candidate pool, and a
  // planted two-condition rule was often missing from a 30-tree refit.
  const forest = growForest(final.binned, labels, final.rows, { ...best!.params, trees: Math.max(100, best!.params.trees) }, mulberry32((config.seed ^ 0x5bd1e995) >>> 0));
  const pool = scoreRules(final, extractRules(forest, ids)).slice(0, MAX_CANDIDATES);
  const variantsScored = scored.size;
  const minDsr = config.minDeflatedSharpe;
  const candidates = pool
    .map((c) => {
      const segs = walkForwardSegments(ctx, c.conds, split, dirSign, bps);
      return { ...c, wf: walkForwardScore(segs, objective), dsr: deflatedSharpeOf(concatReturns(segs), variantsScored) };
    })
    .filter((c) => minDsr == null || (c.dsr ?? 0) >= minDsr)
    .sort((a, b) => b.wf - a.wf || a.conds.length - b.conds.length || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  // One rule per family, best walk-forward first: a rule whose search-region
  // in-zone days overlap a kept rule's with Jaccard ≥ FAMILY_JACCARD is a
  // variant of it, and no single condition anchors more than MAX_PER_ANCHOR
  // rules. Only days [0, searchEnd) count: the holdout never shapes selection.
  const top: typeof candidates = [];
  const anchors = new Map<string, number>();
  for (const c of candidates) {
    const keys = c.conds.map((x) => conditionsKey([x]));
    if (keys.some((k) => (anchors.get(k) ?? 0) >= MAX_PER_ANCHOR)) continue;
    if (top.some((k) => jaccard(k.sig, c.sig, split.searchEnd) >= FAMILY_JACCARD)) continue;
    for (const k of keys) anchors.set(k, (anchors.get(k) ?? 0) + 1);
    top.push(c);
    if (top.length >= config.topK) break;
  }
  if (!top.length) {
    warnings.push(pool.length ? `no rule reached minDeflatedSharpe ${minDsr}` : `no rule reached minSupport ${config.minSupport} within the exposure and trade limits in the search region`);
  }
  const rules = top.map((c) => {
    const rule: Rule = { asset: config.asset, direction: config.direction, horizonDays: config.horizonDays, conditions: c.conds };
    if (config.price) rule.price = config.price;
    return evaluateInCtx(ctx, rule, { split, labels, slippageBps: bps, walkForward: true, trials: variantsScored, windows: config.windows });
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
    variantsScored,
    bestTrial: best,
    trials,
    rules,
    featureImportance,
    warnings,
    durationMs: now() - started,
  };
}

/** Jaccard of two 0/1 signals over days [0, end); 1 when both are empty (identical). */
function jaccard(a: Uint8Array, b: Uint8Array, end: number): number {
  let both = 0;
  let any = 0;
  for (let i = 0; i < end; i++) {
    both += a[i]! & b[i]!;
    any += a[i]! | b[i]!;
  }
  return any ? both / any : 1;
}
