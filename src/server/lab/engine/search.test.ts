import { describe, expect, test } from "bun:test";
import { SearchConfigSchema, type LabDataset, type RuleEvaluation, type SearchConfigInput } from "../types.js";
import { runSearch } from "./search.js";
import { synthetic } from "./testkit.js";

const cfg = (data: LabDataset, over: Partial<SearchConfigInput> = {}) =>
  SearchConfigSchema.parse({
    asset: "SYN",
    metrics: Object.keys(data.metrics),
    transforms: ["raw", "z", "pctile"],
    horizonDays: 2,
    trials: 16,
    ...over,
  });

/** The planted zone: z(a, 30) < −1 AND b ≥ 0 (b iid normal, so its z is b rescaled). */
function isPlanted(r: RuleEvaluation): boolean {
  const a = r.rule.conditions.find((c) => c.feature === "syn:a|z|30");
  const b = r.rule.conditions.find((c) => /^syn:b\|(raw|z)\|/.test(c.feature));
  return !!a && !!b && a.op === "<" && Math.abs(a.threshold + 1) <= 0.4 && b.op === ">=" && Math.abs(b.threshold) <= 0.35;
}

describe("runSearch", () => {
  test("recovers a planted two-condition rule in the top 3 with positive holdout Sharpe", () => {
    for (const seed of [1, 5]) {
      const data = synthetic({ seed, drift: 0.012 });
      const res = runSearch(cfg(data, { seed }), data);
      const hit = res.rules.slice(0, 3).find(isPlanted);
      expect(hit, `seed ${seed}: ${res.rules.slice(0, 3).map((r) => r.text).join(" | ")}`).toBeDefined();
      expect(hit!.holdout!.sharpe).toBeGreaterThan(0);
      expect(hit!.walkForward!.sharpe).toBeGreaterThan(1);
      expect(hit!.support).toBeGreaterThanOrEqual(30);
      expect(hit!.sensitivity!.points.length).toBeGreaterThan(0);
      // Deflated against every variant the search scored; per-fold Sharpes reported.
      expect(res.variantsScored).toBeGreaterThan(500);
      expect(hit!.deflatedSharpe).toBeGreaterThan(0.5);
      expect(hit!.walkForwardFolds).toHaveLength(3);
      expect(hit!.walkForwardFolds!.filter((x) => x > 0).length).toBeGreaterThanOrEqual(2);
      expect(res.featureImportance[0]!.feature.startsWith("syn:a|")).toBe(true);
    }
  }, 20_000);

  test("pure noise: rules with walk-forward and holdout Sharpe both > 1 are rare", () => {
    // Positive WF and holdout Sharpe on noise is a coin flip per rule, so with
    // ten rules per run "> 0" is not a bar; > 1 in both is. Measured: 0 of 12 seeds.
    let survived = 0;
    for (const seed of [100, 101, 102, 103, 104]) {
      const data = synthetic({ seed, drift: 0 });
      const res = runSearch(cfg(data, { seed }), data);
      expect(res.rules.length).toBeGreaterThan(0);
      if (res.rules.some((r) => r.support >= 30 && r.walkForward!.sharpe > 1 && r.holdout!.sharpe > 1)) survived++;
    }
    expect(survived).toBeLessThanOrEqual(1);
  }, 20_000);

  test("minDeflatedSharpe filters final rules; omitted = no filter", () => {
    const data = synthetic({ seed: 1, drift: 0.012, days: 1500 });
    const all = runSearch(cfg(data, { trials: 4 }), data);
    expect(all.rules.some((r) => r.deflatedSharpe! < 0.99)).toBe(true);
    const some = runSearch(cfg(data, { trials: 4, minDeflatedSharpe: 0.99 }), data);
    expect(some.rules.length).toBeGreaterThan(0);
    for (const r of some.rules) expect(r.deflatedSharpe!).toBeGreaterThanOrEqual(0.99);
    const none = runSearch(cfg(data, { trials: 4, minDeflatedSharpe: 1 }), data);
    expect(none.rules).toEqual([]);
    expect(none.warnings.some((w) => /minDeflatedSharpe/.test(w))).toBe(true);
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
