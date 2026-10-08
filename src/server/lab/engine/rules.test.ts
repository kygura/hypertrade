import { describe, expect, test } from "bun:test";
import type { Rule } from "../types.js";
import { mulberry32 } from "./rng.js";
import { canonicalConditions, extractRules, fmtNum, ruleId, ruleText } from "./rules.js";
import { binFeatures, growForest } from "./tree.js";

describe("tree", () => {
  test("finds a planted threshold; NaN rows reach no leaf; importance favours the signal", () => {
    const rng = mulberry32(3);
    const n = 600;
    const x = new Float64Array(n);
    const noise = new Float64Array(n);
    const y = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      x[i] = i % 50 === 0 ? NaN : rng();
      noise[i] = rng();
      y[i] = x[i]! >= 0.6 ? 1 : 0;
    }
    const rows = Int32Array.from({ length: n }, (_, i) => i);
    const binned = binFeatures([x, noise], rows);
    expect(binned.thresholds[0]!.length).toBeLessThanOrEqual(31);
    expect(binned.codes[0]![0]).toBe(255);
    const forest = growForest(binned, y, rows, { featureFrac: 1, minLeaf: 5, bootstrapFrac: 1, trees: 5 }, rng);
    expect(forest.trees.length).toBe(5);
    const root = forest.trees[0]!;
    expect(root.leaf).toBe(false);
    if (!root.leaf) {
      expect(root.feature).toBe(0);
      expect(Math.abs(root.threshold - 0.6)).toBeLessThan(0.04);
    }
    expect(forest.importance[0]!).toBeGreaterThan(10 * forest.importance[1]!);
    const rules = extractRules(forest, ["m:x|raw|0", "m:n|raw|0"]);
    expect(rules.some((r) => r.length === 1 && r[0]!.feature === "m:x|raw|0" && r[0]!.op === ">=")).toBe(true);
  });

  test("single-class training rows grow nothing", () => {
    const rows = Int32Array.from([0, 1, 2]);
    const f = growForest(binFeatures([Float64Array.from([1, 2, 3])], rows), Float64Array.from([1, 1, 1]), rows, { featureFrac: 1, minLeaf: 1, bootstrapFrac: 1, trees: 3 }, mulberry32(1));
    expect(f.trees).toEqual([]);
  });
});

describe("rules", () => {
  const rule: Rule = {
    asset: "BTC",
    direction: "long",
    horizonDays: 14,
    conditions: [
      { feature: "ht:funding|raw|0", op: ">=", threshold: 0.0003 },
      { feature: "cm:CapMVRVCur|z|90", op: "<", threshold: -1.1234 },
    ],
  };

  test("canonical form merges, sorts and rejects empty intervals", () => {
    expect(canonicalConditions([...rule.conditions].reverse())).toEqual(canonicalConditions(rule.conditions));
    expect(
      canonicalConditions([
        { feature: "a|raw|0", op: "<", threshold: 3 },
        { feature: "a|raw|0", op: "<", threshold: 2 },
      ]),
    ).toEqual([{ feature: "a|raw|0", op: "<", threshold: 2 }]);
    expect(
      canonicalConditions([
        { feature: "a|raw|0", op: "<", threshold: 1 },
        { feature: "a|raw|0", op: ">=", threshold: 2 },
      ]),
    ).toBeNull();
  });

  test("id is stable across condition order and asset case, and changes with the rule", () => {
    const id = ruleId(rule);
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(ruleId({ ...rule, asset: "btc", conditions: [...rule.conditions].reverse() })).toBe(id);
    expect(ruleId({ ...rule, direction: "short" })).not.toBe(id);
    expect(ruleId({ ...rule, price: "cm:PriceUSD" })).not.toBe(id);
  });

  test("text", () => {
    expect(ruleText(rule)).toBe("ht:funding raw ≥ 3e-4 AND cm:CapMVRVCur z(90) < -1.123");
    expect(fmtNum(1.2e12)).toBe("1.2e+12");
    expect(fmtNum(0.5)).toBe("0.5");
  });
});
