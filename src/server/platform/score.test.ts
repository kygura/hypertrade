import { describe, expect, test } from "bun:test";
import type { FeatureVector } from "../../shared/platform.js";
import { SCORE_VERSION, scoreOpportunity } from "./score.js";

const setup = { setupKind: "crowded_long", direction: "short" as const };
const fv = (features: Record<string, number | null>, regime: string | null = "range"): FeatureVector => ({ features, inputs: { regime } });

describe("scoreOpportunity", () => {
  test("version is pinned", () => expect(SCORE_VERSION).toBe("score-v1"));

  test("deterministic: twice, and after a JSON round trip of the inputs", () => {
    const f = fv({ ret15mZ: 2.37, priceAccelZ: -1.1, oiChg1hZ: 1.9, fundingZ7d: 2.2, volRatio1hZ: null }, "crowded_long_build");
    const a = scoreOpportunity(f, setup);
    expect(scoreOpportunity(f, setup)).toBe(a);
    expect(scoreOpportunity(JSON.parse(JSON.stringify(f)), JSON.parse(JSON.stringify(setup)))).toBe(a);
  });

  test("surprise x confluence: max |z| times 1 + 0.25 per extra independent source", () => {
    expect(scoreOpportunity(fv({ ret15mZ: 3 }), setup)).toBe(3); // snapshot only
    expect(scoreOpportunity(fv({ ret15mZ: 3, fundingZ7d: 1.2 }), setup)).toBe(3.75); // + flow
    expect(scoreOpportunity(fv({ ret15mZ: -3, fundingZ7d: 1.2 }, "new_shorts"), setup)).toBe(4.5); // + regime, capped 1.5
  });

  test("nothing known, or junk: 0, never NaN", () => {
    expect(scoreOpportunity(fv({}), setup)).toBe(0);
    expect(scoreOpportunity(fv({ ret15mZ: NaN, oiChg1hZ: null }), setup)).toBe(0);
  });
});
