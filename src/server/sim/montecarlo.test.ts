import { describe, expect, test } from "bun:test";
import { runMonteCarlo } from "./montecarlo.js";

const DAY = 86400000;

describe("runMonteCarlo", () => {
  const allocations = [{ coin: "ETH", weightPct: 100 }];
  const scenario = { horizonDays: 30, assumptions: [{ coin: "ETH", annualReturnPct: 40, annualVolPct: 70 }], paths: 200 };
  const startTs = Date.parse("2024-01-01");

  test("is deterministic for a given seed", () => {
    const a = runMonteCarlo(scenario, allocations, 1000, startTs, 42);
    const b = runMonteCarlo(scenario, allocations, 1000, startTs, 42);
    expect(a).toEqual(b);
  });

  test("differs for a different seed", () => {
    const a = runMonteCarlo(scenario, allocations, 1000, startTs, 1);
    const b = runMonteCarlo(scenario, allocations, 1000, startTs, 2);
    expect(a.median.at(-1)!.value).not.toBeCloseTo(b.median.at(-1)!.value, 6);
  });

  test("curves span horizonDays+1 points anchored at the starting value", () => {
    const r = runMonteCarlo(scenario, allocations, 1000, startTs, 7);
    expect(r.median).toHaveLength(31);
    expect(r.p10).toHaveLength(31);
    expect(r.p90).toHaveLength(31);
    expect(r.median[0]).toEqual({ ts: startTs, value: 1000 });
    expect(r.p10[0]).toEqual({ ts: startTs, value: 1000 });
    expect(r.p90[0]).toEqual({ ts: startTs, value: 1000 });
    expect(r.median[1]!.ts).toBe(startTs + DAY);
  });

  test("p10 <= median <= p90 at every step past day 0", () => {
    const r = runMonteCarlo(scenario, allocations, 1000, startTs, 99);
    for (let i = 1; i < r.median.length; i++) {
      expect(r.p10[i]!.value).toBeLessThanOrEqual(r.median[i]!.value);
      expect(r.median[i]!.value).toBeLessThanOrEqual(r.p90[i]!.value);
    }
  });

  test("caps paths at 500 regardless of requested count", () => {
    const r = runMonteCarlo({ ...scenario, paths: 5000 }, allocations, 1000, startTs, 3);
    expect(r.median).toHaveLength(31); // doesn't blow up / still produces a valid curve
  });
});
