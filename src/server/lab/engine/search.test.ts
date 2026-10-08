import { describe, expect, test } from "bun:test";
import { SearchConfigSchema, type LabDataset, type RuleEvaluation, type SearchConfigInput } from "../types.js";
import { inZoneDays } from "./evaluate.js";
import { conditionsKey } from "./rules.js";
import { gauss, mulberry32 } from "./rng.js";
import { runSearch, splitLabels } from "./search.js";
import { calibrate, chooseThreshold } from "./calibrate.js";
import { evaluateRule } from "./evaluate.js";
import { isPlanted, pctileOverlap, SAME_ZONE_JACCARD, synthetic } from "./testkit.js";
import { MIN_DEFLATED_SHARPE } from "./verdict.js";
import { HOLDOUT_FRAC, makeSplit } from "./validate.js";

const cfg = (data: LabDataset, over: Partial<SearchConfigInput> = {}) =>
  SearchConfigSchema.parse({
    asset: "SYN",
    metrics: Object.keys(data.metrics),
    transforms: ["raw", "z", "pctile"],
    horizonDays: 2,
    trials: 16,
    ...over,
  });

describe("runSearch", () => {
  test("recovers a planted two-condition rule in the top 3 with positive holdout Sharpe", () => {
    for (const seed of [1, 5]) {
      const data = synthetic({ seed, drift: 0.012 });
      const res = runSearch(cfg(data, { seed }), data);
      // The matcher also accepts a's pctile(30) as the planted z(30) < −1
      // zone; justified only while the two forms' in-zone days overlap.
      expect(pctileOverlap(data, 0.3)).toBeGreaterThanOrEqual(SAME_ZONE_JACCARD);
      const hit = res.rules.slice(0, 3).find((r) => isPlanted(r, data));
      expect(hit, `seed ${seed}: ${res.rules.slice(0, 3).map((r) => r.text).join(" | ")}`).toBeDefined();
      expect(hit!.holdout!.sharpe).toBeGreaterThan(0);
      expect(hit!.walkForward!.sharpe).toBeGreaterThan(1);
      expect(hit!.support).toBeGreaterThanOrEqual(30);
      expect(hit!.sensitivity!.points.length).toBeGreaterThan(0);
      const a = hit!.rule.conditions.find((c) => c.feature.startsWith("syn:a|"))!;
      if (a.feature === "syn:a|pctile|30") expect(pctileOverlap(data, a.threshold)).toBeGreaterThanOrEqual(SAME_ZONE_JACCARD);
      // Deflated against the effective (clustered) trials, far fewer than the
      // raw variants; the planted rule clears the whole save bar.
      expect(res.variantsScored).toBeGreaterThan(500);
      expect(res.effectiveTrials).toBeGreaterThan(20);
      expect(res.effectiveTrials!).toBeLessThan(res.variantsScored! / 5);
      expect(hit!.deflatedSharpe).toBeGreaterThanOrEqual(MIN_DEFLATED_SHARPE);
      expect(hit!.verdict).toEqual({ level: "robust", reasons: [] });
      expect(hit!.walkForwardFolds).toHaveLength(3);
      expect(hit!.walkForwardFolds!.filter((x) => x > 0).length).toBeGreaterThanOrEqual(2);
      expect(res.featureImportance[0]!.feature.startsWith("syn:a|")).toBe(true);
    }
  }, 20_000);

  test("calibration: at MIN_DEFLATED_SHARPE, ≤ 1 of 20 noise searches has a robust top-10 rule; planted rules stay robust", () => {
    // LAB.md "Calibration" (the 40/20-seed table comes from calibrate.ts).
    // Before N_eff, the planted rule's deflated Sharpe was 0.39–0.89 and the
    // bar at 0.95 rejected it; without the deflated Sharpe, noise passed the
    // rest of the bar in 6 of 20 seeds here.
    const c = calibrate({
      thresholds: [0.5, 0.8, 0.9, 0.95],
      noiseSeeds: Array.from({ length: 20 }, (_, i) => 1000 + i),
      plantedSeeds: Array.from({ length: 12 }, (_, i) => 2000 + i),
      drifts: [0.012, 0.008],
    });
    expect(chooseThreshold(c)).toBe(MIN_DEFLATED_SHARPE);
    const row = c.rows.find((r) => r.threshold === MIN_DEFLATED_SHARPE)!;
    expect(row.noiseAny).toBeLessThanOrEqual(1);
    expect(row.noiseTop1).toBe(0);
    const [strong, weak] = row.planted;
    expect(strong!.robust).toBeGreaterThanOrEqual(9);
    expect(strong!.robust).toBe(strong!.found);
    expect(weak!.robust).toBeGreaterThanOrEqual(4);
    expect(c.effectiveTrials.max).toBeLessThan(c.variantsScored.min);
  }, 180_000);

  test("effectiveTrials is the N of every deflated Sharpe; an explicit re-evaluation with it reproduces the search's", () => {
    const data = synthetic({ seed: 1, drift: 0.012, days: 1500 });
    const res = runSearch(cfg(data, { trials: 4 }), data);
    expect(res.effectiveTrials).toBeGreaterThanOrEqual(1);
    expect(res.effectiveTrials!).toBeLessThanOrEqual(res.variantsScored!);
    expect(Number.isInteger(res.effectiveTrials)).toBe(true);
    const top = res.rules[0]!;
    const again = evaluateRule(top.rule, data, { slippageBps: res.config.slippageBps, labelQuantile: res.config.labelQuantile, trials: res.effectiveTrials });
    expect(again.walkForward).toEqual(top.walkForward);
    expect(again.deflatedSharpe).toBeCloseTo(top.deflatedSharpe!, 12);
    const raw = evaluateRule(top.rule, data, { slippageBps: res.config.slippageBps, trials: res.variantsScored });
    expect(raw.deflatedSharpe!).toBeLessThan(top.deflatedSharpe!);
  });

  test("every rule carries a verdict; minVerdict drops lower ones after selection", () => {
    const data = synthetic({ seed: 1, drift: 0.006, days: 1500 });
    const all = runSearch(cfg(data, { trials: 4 }), data);
    for (const r of all.rules) expect(r.verdict!.level).toMatch(/^(robust|candidate|fragile|weak|fails_holdout)$/);
    expect(new Set(all.rules.map((r) => r.verdict!.level)).size).toBeGreaterThan(1);
    const robust = runSearch(cfg(data, { trials: 4, minVerdict: "robust" }), data);
    expect(robust.rules.map((r) => r.id)).toEqual(all.rules.filter((r) => r.verdict!.level === "robust").map((r) => r.id));
    expect(robust.warnings.some((w) => /below minVerdict robust/.test(w))).toBe(true);
    const cand = runSearch(cfg(data, { trials: 4, minVerdict: "candidate" }), data);
    const kept = all.rules.filter((r) => ["robust", "candidate"].includes(r.verdict!.level));
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(all.rules.length);
    expect(cand.rules.map((r) => r.id)).toEqual(kept.map((r) => r.id));
  });

  test("minDeflatedSharpe filters final rules; omitted = no filter", () => {
    const data = synthetic({ seed: 1, drift: 0.006, days: 1500 });
    const all = runSearch(cfg(data, { trials: 4 }), data);
    expect(all.rules.some((r) => r.deflatedSharpe! < 0.8)).toBe(true);
    const some = runSearch(cfg(data, { trials: 4, minDeflatedSharpe: 0.8 }), data);
    expect(some.rules.length).toBeGreaterThan(0);
    for (const r of some.rules) expect(r.deflatedSharpe!).toBeGreaterThanOrEqual(0.8);
    const none = runSearch(cfg(data, { trials: 4, minDeflatedSharpe: 1 }), data);
    expect(none.rules).toEqual([]);
    expect(none.warnings.some((w) => /minDeflatedSharpe/.test(w))).toBe(true);
  });

  test("exposure and trade limits: every rule trades enough and is neither always in nor almost never", () => {
    const data = synthetic({ seed: 4, drift: 0.01, days: 1500 });
    const res = runSearch(cfg(data, { trials: 4 }), data);
    const years = res.rules[0]!.inSample.days / 365;
    for (const r of res.rules) {
      expect(r.inSample.exposure).toBeGreaterThanOrEqual(0.05);
      expect(r.inSample.exposure).toBeLessThanOrEqual(0.95);
      expect(r.inSample.trades).toBeGreaterThanOrEqual(Math.max(3, Math.ceil(0.5 * years)));
    }
    const tight = runSearch(cfg(data, { trials: 4, minExposure: 0.3, maxExposure: 0.6 }), data);
    expect(tight.rules.length).toBeGreaterThan(0);
    for (const r of tight.rules) {
      expect(r.inSample.exposure).toBeGreaterThanOrEqual(0.3);
      expect(r.inSample.exposure).toBeLessThanOrEqual(0.6);
    }
    const busy = runSearch(cfg(data, { trials: 4, minTradesPerYear: 40 }), data);
    for (const r of busy.rules) expect(r.inSample.tradesPerYear).toBeGreaterThanOrEqual(40);
    expect(() => runSearch(cfg(data, { minExposure: 0.6, maxExposure: 0.5 }), data)).toThrow(/minExposure/);
  });

  test("stationarity: random-walk metrics flagged false never yield raw conditions", () => {
    const data = synthetic({ seed: 3, drift: 0.01, days: 1200 });
    const plain = runSearch(cfg(data, { trials: 4 }), data);
    const flagged = runSearch(cfg(data, { trials: 4 }), { ...data, stationary: { "syn:a": false, "syn:c": false } });
    // 4 metrics × (raw + z, pctile at 3 windows) = 28; minus raw for a and c.
    expect(plain.featureCount).toBe(28);
    expect(flagged.featureCount).toBe(26);
    const feats = flagged.rules.flatMap((r) => r.rule.conditions.map((c) => c.feature));
    expect(feats.some((f) => /^syn:[ac]\|raw\|/.test(f))).toBe(false);
    expect(flagged.featureImportance.some((f) => /^syn:[ac]\|raw\|/.test(f.feature))).toBe(false);
  });

  test("final rules are distinct families: in-sample Jaccard < 0.8, ≤ 2 rules per anchor condition", () => {
    const data = synthetic({ seed: 1, drift: 0.012, days: 1500 });
    const res = runSearch(cfg(data, { trials: 4 }), data);
    expect(res.rules.length).toBeGreaterThan(3);
    const searchEnd = data.t.length - Math.floor(data.t.length * HOLDOUT_FRAC);
    const zones = res.rules.map((r) => inZoneDays(r.rule, data).slice(0, searchEnd));
    for (let i = 0; i < zones.length; i++) {
      for (let j = 0; j < i; j++) {
        let both = 0;
        let any = 0;
        for (let k = 0; k < searchEnd; k++) {
          both += +(zones[i]![k]! && zones[j]![k]!);
          any += +(zones[i]![k]! || zones[j]![k]!);
        }
        expect(both / any, `${res.rules[i]!.text} vs ${res.rules[j]!.text}`).toBeLessThan(0.8);
      }
    }
    const anchors = new Map<string, number>();
    for (const r of res.rules) for (const c of r.rule.conditions) anchors.set(conditionsKey([c]), (anchors.get(conditionsKey([c])) ?? 0) + 1);
    expect(Math.max(...anchors.values())).toBeLessThanOrEqual(2);
  });

  test("fold labels use the fold's own training rows: later test blocks never move them", () => {
    const data = synthetic({ seed: 8, drift: 0, days: 1200 });
    const split = makeSplit(1200, 3, 5);
    const o = { t: data.t, horizonDays: 5, direction: "long" as const, quantile: 0.3 };
    const a = splitLabels({ ...o, price: data.price }, split);
    const f0 = split.folds[0]!;
    // Training rows of fold 0 are labelled, everything from the purge on is not.
    expect(Number.isNaN(a.folds[0]![f0.purgedEnd - 1]!)).toBe(false);
    expect(Number.isNaN(a.folds[0]![f0.purgedEnd]!)).toBe(true);
    // A wild regime after fold 0's training edge: fold 0 labels identical, the
    // whole-region quantile (the final refit's) moves.
    const price = data.price.map((p, i) => (i >= f0.testFrom ? p * (1 + 0.5 * Math.sin(i)) : p));
    const b = splitLabels({ ...o, price }, split);
    expect(Array.from(b.folds[0]!)).toEqual(Array.from(a.folds[0]!));
    const differ = (x: Float64Array, y: Float64Array) => x.some((v, i) => i < f0.purgedEnd && !Object.is(v, y[i]));
    expect(differ(b.final, a.final)).toBe(true);
    expect(differ(a.final, a.folds[0]!)).toBe(true);
  });

  test("the holdout cannot influence what the search picks", () => {
    // Replace the last 20% (prices and every metric) with fresh noise: the
    // rules, their order and every search-region number must not move.
    const data = synthetic({ seed: 1, drift: 0.012, days: 1500 });
    const n = data.t.length;
    const searchEnd = n - Math.floor(n * HOLDOUT_FRAC);
    const rng = mulberry32(99);
    const scrambled: LabDataset = { ...data, price: [...data.price], metrics: Object.fromEntries(Object.entries(data.metrics).map(([k, v]) => [k, [...v]])) };
    for (let i = searchEnd; i < n; i++) {
      scrambled.price[i] = scrambled.price[i - 1]! * (1 + 0.05 * gauss(rng));
      for (const v of Object.values(scrambled.metrics)) v[i] = 3 * gauss(rng);
    }
    const a = runSearch(cfg(data, { trials: 6 }), data);
    const b = runSearch(cfg(scrambled, { trials: 6 }), scrambled);
    const pick = (r: RuleEvaluation) => ({
      rule: r.rule,
      precision: r.precision,
      support: r.support,
      inSample: r.inSample,
      walkForward: r.walkForward,
      walkForwardFolds: r.walkForwardFolds,
      deflatedSharpe: r.deflatedSharpe,
      sensitivity: r.sensitivity,
    });
    expect(b.rules.map(pick)).toEqual(a.rules.map(pick));
    expect(b.trials).toEqual(a.trials);
    expect(b.featureImportance).toEqual(a.featureImportance);
    expect(b.variantsScored).toBe(a.variantsScored);
    expect(b.effectiveTrials).toBe(a.effectiveTrials);
    expect(b.rules[0]!.holdout).not.toEqual(a.rules[0]!.holdout);
  });

  test("deterministic: same seed, same result", () => {
    const data = synthetic({ seed: 2, drift: 0.01, days: 1200 });
    const strip = (r: ReturnType<typeof runSearch>) => JSON.stringify({ ...r, durationMs: 0 });
    const a = runSearch(cfg(data, { trials: 6, seed: 9 }), data);
    const b = runSearch(cfg(data, { trials: 6, seed: 9 }), data);
    expect(strip(a)).toBe(strip(b));
    const c = runSearch(cfg(data, { trials: 6, seed: 10 }), data);
    expect(strip(c)).not.toBe(strip(a));
  });

  test("deadline: stops starting trials, warns, still returns rules", () => {
    const data = synthetic({ seed: 2, drift: 0.01, days: 1200 });
    let clock = 0;
    const progress: number[] = [];
    const res = runSearch(cfg(data, { trials: 16 }), data, { deadlineMs: 2500, now: () => (clock += 1000), onProgress: (k) => progress.push(k) });
    expect(res.trialsRun).toBe(3);
    expect(res.trialsRun).toBeLessThan(res.config.trials);
    expect(progress).toEqual([1, 2, 3]);
    expect(res.warnings.some((w) => /deadline/.test(w))).toBe(true);
    expect(res.bestTrial).not.toBeNull();
  });

  test("refuses short price history and too many features", () => {
    const short = synthetic({ seed: 1, days: 300 });
    expect(() => runSearch(cfg(short), short)).toThrow(/at least 365/);
    const data = synthetic({ seed: 1, days: 400 });
    for (let i = 0; i < 32; i++) data.metrics[`syn:x${i}`] = data.metrics["syn:b"]!;
    expect(() => runSearch(cfg(data, { transforms: ["raw", "z", "rsi", "ma_ratio", "roc", "vol", "pctile"] }), data)).toThrow(/cap of 600/);
  });

  test("short direction and custom zones run end to end", () => {
    const data = synthetic({ seed: 6, drift: 0, days: 800 });
    const short = runSearch(cfg(data, { trials: 2, direction: "short" }), data);
    for (const r of short.rules) expect(r.rule.direction).toBe("short");
    expect(short.rules[0]!.benchmark.inSample.totalReturn).toBeCloseTo(
      runSearch(cfg(data, { trials: 2, direction: "short", seed: 3 }), data).rules[0]!.benchmark.inSample.totalReturn,
      12,
    );
    const zones = runSearch(cfg(data, { trials: 2, customZones: [{ from: "2018-03-01", to: "2018-04-15" }, { from: "2019-01-01", to: "2019-02-01" }], minSupport: 5 }), data);
    expect(zones.trialsRun).toBe(2);
    expect(() => runSearch(cfg(data, { trials: 2, customZones: [{ from: "2030-01-01", to: "2030-02-01" }] }), data)).toThrow(/labelled good/);
  });

  test("result shape: splits, ranking, metadata", () => {
    const data = synthetic({ seed: 4, drift: 0.01, days: 1500 });
    const res = runSearch(cfg(data, { trials: 4, topK: 5, metrics: [...Object.keys(data.metrics), "syn:missing"] }), data);
    expect(res.dataRange).toEqual({ from: "2018-01-01", to: res.dataRange.to, days: 1500, holdoutFrom: res.dataRange.holdoutFrom });
    expect(res.dataRange.holdoutFrom > res.rules[0]!.inSample.to).toBe(true);
    expect(res.warnings.some((w) => w.includes("syn:missing"))).toBe(true);
    expect(res.rules.length).toBeLessThanOrEqual(5);
    const wf = res.rules.map((r) => r.walkForward!.sharpe);
    expect([...wf].sort((a, b) => b - a)).toEqual(wf);
    expect(new Set(res.rules.map((r) => r.id)).size).toBe(res.rules.length);
    for (const r of res.rules) {
      expect(r.holdout!.from).toBe(res.dataRange.holdoutFrom);
      expect(r.benchmark.holdout).not.toBeNull();
      expect(r.latest.date).toBe(res.dataRange.to);
    }
  });
});
