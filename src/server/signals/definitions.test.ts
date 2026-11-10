import { describe, expect, test } from "bun:test";
import { UNIVERSE_ASSET } from "../../shared/research.js";
import { parseFeatureId } from "../lab/engine/features.js";
import { getMetric } from "../lab/providers/registry.js";
import { RuleSchema } from "../lab/types.js";
import { SETUPS } from "../platform/setups.js";
import { DEFINITIONS, definitionForKind, definitionRule, DefinitionRuleSchema } from "./definitions.js";

describe("signal definitions", () => {
  test("every definition parses as a Lab rule once an asset is filled in, reads only ht:* asset metrics, and has a unique id", () => {
    expect(new Set(DEFINITIONS.map((d) => d.id)).size).toBe(DEFINITIONS.length);
    for (const d of DEFINITIONS) {
      expect(DefinitionRuleSchema.safeParse(d.rule).success).toBe(true);
      expect(RuleSchema.safeParse({ ...d.rule, asset: "ETH" }).success).toBe(true);
      expect(definitionRule(d).asset).toBe(UNIVERSE_ASSET);
      for (const c of d.rule.conditions) {
        const metric = getMetric(parseFeatureId(c.feature).metric);
        expect(metric?.provider).toBe("ht");
        expect(metric?.scope).toBe("asset");
      }
    }
  });

  test("every platform setup kind is named by exactly one definition's intradayKinds, and only those", () => {
    const named = DEFINITIONS.flatMap((d) => d.intradayKinds);
    for (const s of SETUPS) expect(named.filter((k) => k === s.kind)).toHaveLength(1);
    expect(named.every((k) => SETUPS.some((s) => s.kind === k))).toBe(true);
    expect(definitionForKind("crowded_long")?.id).toBe("funding_fade");
    expect(definitionForKind("negative_funding_squeeze")?.id).toBe("negative_funding_build");
    expect(definitionForKind("deleveraging_washout")?.id).toBe("washout_reclaim");
    expect(definitionForKind("vol_expansion_breakout")?.id).toBe("range_breakout");
  });
});
