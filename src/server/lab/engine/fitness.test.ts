import { describe, expect, test } from "bun:test";
import type { Trend } from "../types.js";
import { simulate, type Segment } from "./backtest.js";
import { evaluateRule } from "./evaluate.js";
import { FITNESS, fitnessOf, maxDrawdownOf, regimeStats } from "./fitness.js";
import { synthetic } from "./testkit.js";

const seg = (a: number, ret: number[], held: number[]): Segment => ({ a, b: a + ret.length, ret: Float64Array.from(ret), held: Float64Array.from(held) });

describe("fitness (docs/AUTORESEARCH.md)", () => {
  test("max drawdown of a return track", () => {
    expect(maxDrawdownOf([0.1, -0.5, 0.2])).toBeCloseTo(-0.5, 12);
    expect(maxDrawdownOf([0.01, 0.02])).toBe(0);
  });

  test("a return is filed under the regime known when the position was taken, in-market days only", () => {
    // Day 3's return was earned by the position taken at the close of day 2 (trend "up"); day 4 is flat.
    const trend: (Trend | null)[] = [null, "down", "up", "range", "range"];
    const stats = regimeStats([seg(2, [0.01, 0.02, 0.5], [1, 1, 0])], trend);
    expect(stats.map((s) => [s.trend, s.days])).toEqual([["up", 1], ["down", 1]]);
    expect(stats.find((s) => s.trend === "up")!.meanDaily).toBeCloseTo(0.02, 12);
    expect(stats.find((s) => s.trend === "down")!.meanDaily).toBeCloseTo(0.01, 12);
  });

  test("score = Sharpe − drawdown, volatility and worst-regime penalties, each zero inside its budget", () => {
    const calm = Array.from({ length: 200 }, (_, i) => (i % 2 ? 0.004 : -0.002));
    const trend = calm.map((): Trend => "up");
    const a = fitnessOf([seg(1, calm, calm.map(() => 1))], [...trend, "up"]);
    expect(a.penalties).toEqual({ drawdown: 0, vol: 0, regime: 0 });
    expect(a.score).toBeCloseTo(a.sharpe, 12);

    // Same track with one −40% day: 20 points over the drawdown budget cost 1.0, and volatility goes over its budget.
    const hit: number[] = [...calm];
    hit[100] = -0.4;
    const b = fitnessOf([seg(1, hit, hit.map(() => 1))], [...trend, "up"]);
    expect(b.maxDrawdown).toBeLessThan(-0.39);
    expect(b.penalties.drawdown).toBeCloseTo((-b.maxDrawdown - FITNESS.ddBudget) / FITNESS.ddBudget, 12);
    expect(b.penalties.vol).toBeCloseTo((b.vol - FITNESS.volBudget) / FITNESS.volBudget, 12);
    expect(b.score).toBeCloseTo(b.sharpe - b.penalties.drawdown - b.penalties.vol - b.penalties.regime, 12);

    // Gains in "up", losses in "down": the losing regime costs a quarter of its Sharpe, floored.
    const mixed = Array.from({ length: 120 }, (_, i) => (i < 60 ? 0.005 + (i % 2) * 0.002 : -0.005 - (i % 2) * 0.002));
    const tr = mixed.map((_, i): Trend => (i < 60 ? "up" : "down"));
    const c = fitnessOf([seg(1, mixed, mixed.map(() => 1))], [...tr, "down"]);
    expect(c.regimes.find((r) => r.trend === "down")!.sharpe).toBeLessThan(FITNESS.regimeFloor);
    expect(c.penalties.regime).toBeCloseTo(-FITNESS.regimeWeight * FITNESS.regimeFloor, 12);
  });

  test("a regime with too few days in market is reported and not penalised; no trade is untested", () => {
    const ret = Array.from({ length: 20 }, () => -0.01);
    const f = fitnessOf([seg(1, ret, ret.map(() => 1))], Array.from({ length: 21 }, (): Trend => "range"));
    expect(f.regimes[0]!.days).toBe(20);
    expect(f.penalties.regime).toBe(0);
    const flat = fitnessOf([simulate(new Float64Array(50), new Float64Array(50), 1, 50, 10)], Array.from({ length: 50 }, (): Trend => "up"));
    expect(flat).toMatchObject({ score: 0, untested: true });
  });

  test("an evaluation carries the fitness of its walk-forward returns", () => {
    const d = synthetic({ seed: 7, drift: 0.012 });
    const ev = evaluateRule(
      { asset: "SYN", direction: "long", horizonDays: 1, conditions: [{ feature: "syn:a|z|30", op: "<", threshold: -1 }, { feature: "syn:b|raw|0", op: ">=", threshold: 0 }] },
      d,
      { slippageBps: 10 },
    );
    expect(ev.fitness!.sharpe).toBeCloseTo(ev.walkForward!.sharpe, 9);
    expect(ev.fitness!.maxDrawdown).toBeCloseTo(ev.walkForward!.maxDrawdown, 9);
    expect(ev.fitness!.score).toBeGreaterThan(1);
    expect(ev.fitness!.regimes.reduce((a, r) => a + r.days, 0)).toBeLessThanOrEqual(Math.round(ev.walkForward!.exposure * ev.walkForward!.days));
  });
});
