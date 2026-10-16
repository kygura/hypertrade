import { describe, expect, test } from "bun:test";
import type { FeatureVector } from "../../shared/platform.js";
import { SCORE_VERSION, scoreOpportunity } from "./score.js";

const fv = (features: Record<string, number | null>, regime: string | null = "range"): FeatureVector => ({ features, inputs: { regime } });

describe("scoreOpportunity", () => {
  test("version is pinned", () => expect(SCORE_VERSION).toBe("score-v1"));

  test("deterministic: twice, and after a JSON round trip of the inputs", () => {
    const f = fv({ ret15mZ: 2.37, priceAccelZ: -1.1, oiChg1hZ: 1.9, fundingZ24h: 2.2, volRatio1hZ: null }, "crowded_long_build");
    const a = scoreOpportunity(f);
    expect(scoreOpportunity(f)).toBe(a);
    expect(scoreOpportunity(JSON.parse(JSON.stringify(f)))).toBe(a);
  });

  test("surprise x confluence: max |z| times 1 + 0.25 per extra independent source", () => {
    expect(scoreOpportunity(fv({ ret15mZ: 3 }))).toBe(3); // snapshot only
    expect(scoreOpportunity(fv({ ret15mZ: 3, fundingZ24h: 1.2 }))).toBe(3.75); // + flow
    expect(scoreOpportunity(fv({ ret15mZ: -3, fundingZ24h: 1.2 }, "new_shorts"))).toBe(4.5); // + regime, capped 1.5
  });

  test("nothing known, or junk: 0, never NaN", () => {
    expect(scoreOpportunity(fv({}))).toBe(0);
    expect(scoreOpportunity(fv({ ret15mZ: NaN, oiChg1hZ: null }))).toBe(0);
  });
});
