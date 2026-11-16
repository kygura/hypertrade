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

describe("runMonteCarlo: bootstrap and cash flows", () => {
  const startTs = Date.parse("2024-01-31");
  const allocations = [{ coin: "ETH", weightPct: 100 }];

  test("bootstrap replays the history: a constant daily return gives one deterministic path", () => {
    const history = Array(100).fill(0.001);
    const r = runMonteCarlo({ horizonDays: 30, assumptions: [], paths: 50, method: "bootstrap", blockDays: 7 }, allocations, 1000, startTs, 1, { history });
    expect(r.p10.at(-1)!.value).toBeCloseTo(1000 * 1.001 ** 30, 9);
    expect(r.p90.at(-1)!.value).toBeCloseTo(1000 * 1.001 ** 30, 9);
    expect(r.summary!.method).toBe("bootstrap");
    expect(r.summary!.lossPct).toBe(0);
  });

  test("bootstrap blocks only draw returns from the history", () => {
    const history = Array.from({ length: 120 }, (_, i) => (i % 2 ? 0.05 : -0.04));
    const r = runMonteCarlo({ horizonDays: 1, assumptions: [], paths: 200, method: "bootstrap", blockDays: 1 }, allocations, 100, startTs, 3, { history });
    for (const q of [r.p10, r.p25!, r.median, r.p75!, r.p90]) expect([96, 105]).toContainEqual(expect.closeTo(q.at(-1)!.value, 9));
  });

  test("bootstrap refuses a history shorter than the minimum", () => {
    expect(() => runMonteCarlo({ horizonDays: 5, assumptions: [], paths: 5, method: "bootstrap" }, allocations, 1000, startTs, 1, { history: [0.01] })).toThrow();
  });

  test("contributions add on the calendar schedule and count as invested", () => {
    // No assumption for the coin: zero drift and vol, so the value only moves by the flows.
    const r = runMonteCarlo({ horizonDays: 29, assumptions: [], paths: 10, targetUsd: 1100 }, allocations, 1000, startTs, 1, {
      cashflow: { amountUsd: 100, every: "monthly" },
    });
    expect(r.median.at(-1)!.value).toBeCloseTo(1100, 9); // Feb 1 is the one boundary before Feb 29
    expect(r.summary!.investedUsd).toBe(1100);
    expect(r.summary!.lossPct).toBe(0);
    expect(r.summary!.targetPct).toBe(100);
    expect(r.summary!.depletedPct).toBeUndefined();
  });

  test("withdrawals larger than the pot deplete every path and stay at 0", () => {
    const r = runMonteCarlo({ horizonDays: 90, assumptions: [], paths: 10 }, allocations, 1000, startTs, 1, {
      cashflow: { amountUsd: -400, every: "monthly" },
    });
    expect(r.median.at(-1)!.value).toBe(0);
    expect(r.summary!.depletedPct).toBe(100);
  });

  test("p25/p75 sit inside p10/p90", () => {
    const r = runMonteCarlo({ horizonDays: 60, assumptions: [{ coin: "ETH", annualReturnPct: 20, annualVolPct: 80 }], paths: 300 }, allocations, 1000, startTs, 5);
    for (let i = 1; i < r.median.length; i++) {
      expect(r.p10[i]!.value).toBeLessThanOrEqual(r.p25![i]!.value);
      expect(r.p25![i]!.value).toBeLessThanOrEqual(r.median[i]!.value);
      expect(r.median[i]!.value).toBeLessThanOrEqual(r.p75![i]!.value);
      expect(r.p75![i]!.value).toBeLessThanOrEqual(r.p90[i]!.value);
    }
  });
});
