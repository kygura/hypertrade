import { describe, expect, test } from "bun:test";
import { UNIVERSE_ASSET } from "../../shared/research.js";
import { parseFeatureId, transformSeries } from "../lab/engine/features.js";
import { getMetric } from "../lab/providers/registry.js";
import { RuleSchema } from "../lab/types.js";
import { SETUPS } from "../platform/setups.js";
import { DEFINITIONS, definitionForKind, definitionRule } from "./definitions.js";

describe("signal definitions", () => {
  test("every definition parses as a Lab rule once an asset is filled in, reads only ht:* and okx:oi asset metrics, and has a unique id", () => {
    expect(new Set(DEFINITIONS.map((d) => d.id)).size).toBe(DEFINITIONS.length);
    for (const d of DEFINITIONS) {
      expect(RuleSchema.safeParse({ ...d.rule, asset: "ETH" }).success).toBe(true);
      expect(definitionRule(d).asset).toBe(UNIVERSE_ASSET);
      for (const c of d.rule.conditions) {
        const metric = getMetric(parseFeatureId(c.feature).metric);
        expect(["ht", "okx"]).toContain(metric!.provider);
        expect(metric?.scope).toBe("asset");
        // ht:oi is collector snapshots, weeks deep: no definition can be studied on it.
        expect(metric!.id).not.toBe("ht:oi");
      }
    }
  });

  test("every platform setup kind is named by exactly one definition per side it can take, and only on those sides", () => {
    const sidesOf = (s: (typeof SETUPS)[number]) => (typeof s.direction === "string" ? [s.direction] : (["long", "short"] as const));
    for (const s of SETUPS) {
      for (const side of sidesOf(s)) expect(DEFINITIONS.filter((d) => d.rule.direction === side && d.intradayKinds.includes(s.kind))).toHaveLength(1);
    }
    for (const d of DEFINITIONS) {
      for (const k of d.intradayKinds) {
        const s = SETUPS.find((x) => x.kind === k);
        expect(s && (sidesOf(s) as readonly string[]).includes(d.rule.direction)).toBe(true);
      }
    }
    expect(definitionForKind("crowded_long", "short")?.id).toBe("funding_fade");
    expect(definitionForKind("crowded_long", "long")).toBeUndefined();
    expect(definitionForKind("negative_funding_squeeze", "long")?.id).toBe("negative_funding_build");
    expect(definitionForKind("deleveraging_washout", "long")?.id).toBe("washout_reclaim");
    expect(definitionForKind("vol_expansion_breakout", "long")?.id).toBe("range_breakout");
    expect(definitionForKind("vol_expansion_breakout", "short")?.id).toBe("range_breakdown");
  });

  test("range_breakdown's pctile < 0.01 is exactly a close below every prior close in the window (the mirror of pctile ≥ 1)", () => {
    const below = (xs: number[]) => transformSeries(xs, "pctile", 20).at(-1)! < 0.01;
    const prior = Array.from({ length: 19 }, (_, i) => 100 + ((i * 7) % 11));
    expect(below([...prior, 99.99])).toBe(true);
    expect(below([...prior, 100])).toBe(false); // equal to the lowest prior close: not below it
    expect(below([...prior, 100.5])).toBe(false);
    // With only the fewest closes pctile accepts (10 of 20), the smallest non-zero rank (½ / 9) is still above 0.01.
    const sparse = [...Array(10).fill(NaN), ...prior.slice(0, 9), 100];
    expect(transformSeries(sparse, "pctile", 20).at(-1)!).toBeGreaterThan(0.01);
    expect(below([...Array(10).fill(NaN), ...prior.slice(0, 9), 99])).toBe(true);
  });
});
