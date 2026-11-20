import { describe, expect, test } from "bun:test";
import type { Direction, Fitness, RuleEvaluation, Trend } from "../types.js";
import { stanceOf } from "./stance.js";

const fit = (score: number, regimes: Array<[Trend, number, number]>): Fitness => ({
  score,
  sharpe: score,
  maxDrawdown: -0.1,
  vol: 0.2,
  penalties: { drawdown: 0, vol: 0, regime: 0 },
  days: 500,
  regimes: regimes.map(([trend, days, meanDaily]) => ({ trend, days, meanDaily, sharpe: 1, hitRate: 0.5 })),
});
const ev = (id: string, direction: Direction, firingNow: boolean, fitness?: Fitness): Pick<RuleEvaluation, "id" | "text" | "rule" | "firingNow" | "fitness"> => ({
  id,
  text: id,
  firingNow,
  fitness,
  rule: { asset: "BTC", direction, horizonDays: 7, conditions: [{ feature: "x:y|raw|0", op: "<", threshold: 0 }] },
});

describe("stance (docs/AUTORESEARCH.md)", () => {
  test("only firing rules with positive fitness and 30+ days in today's regime count, weighted by those days", () => {
    const s = stanceOf("BTC", "2026-11-19", "down", [
      ev("a", "long", true, fit(1.2, [["down", 100, 0.002], ["up", 300, 0.01]])),
      ev("b", "long", true, fit(0.8, [["down", 300, 0.001]])),
      ev("quiet", "long", false, fit(3, [["down", 400, 0.05]])),
      ev("thin", "long", true, fit(2, [["down", 29, 0.05]])),
      ev("bad", "long", true, fit(-0.1, [["down", 400, 0.05]])),
      ev("s", "short", false, fit(1, [["down", 200, 0.003]])),
    ]);
    expect(s.side).toBe("long");
    expect(s.long).toMatchObject({ total: 5, firing: 4, counted: 2, days: 400 });
    expect(s.long.meanDailyBps).toBeCloseTo(((100 * 0.002 + 300 * 0.001) / 400) * 1e4, 9);
    expect(s.short).toMatchObject({ total: 1, firing: 0, counted: 0, meanDailyBps: null });
    expect(s.reasons).toContain("no short rule fires (0 of 1)");
  });

  test("a firing side that lost money in this regime does not pay; both paying takes the larger and says so; nothing is flat", () => {
    const lost = stanceOf("BTC", "2026-11-19", "range", [ev("a", "long", true, fit(1, [["range", 90, -0.001]]))]);
    expect(lost.side).toBe("flat");
    const both = stanceOf("BTC", "2026-11-19", "range", [ev("a", "long", true, fit(1, [["range", 90, 0.001]])), ev("b", "short", true, fit(1, [["range", 90, 0.002]]))]);
    expect(both.side).toBe("short");
    expect(both.reasons.at(-1)).toContain("both sides");
    expect(stanceOf("BTC", "2026-11-19", null, [ev("a", "long", true, fit(1, [["up", 90, 0.01]]))]).side).toBe("flat");
    expect(stanceOf("BTC", "2026-11-19", "up", [])).toMatchObject({ side: "flat", reasons: ["no long rule to read", "no short rule to read"] });
  });
});
