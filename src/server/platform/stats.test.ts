import { describe, expect, test } from "bun:test";
import { groupStats } from "./stats.js";
import type { OutcomeRow } from "./store.js";

const row = (netReturn: number, o: Partial<OutcomeRow> = {}): OutcomeRow => ({
  opportunityId: crypto.randomUUID(), setupKind: "squeeze", regime: "trend", liquidityTier: 1, horizon: "1h", grossReturn: netReturn, netReturn, ...o,
});

describe("groupStats", () => {
  test("n >= 5: hitRate, mean and t-interval (df 4, t = 2.776)", () => {
    const [s] = groupStats([0.01, 0.02, 0.03, 0.04, 0.05].map((x) => row(x)));
    // mean .03, sd = sqrt(2.5e-4) = .0158114, half-width = 2.776 * .0158114 / sqrt(5) = .019630
    expect(s.n).toBe(5);
    expect(s.hitRate).toBe(1);
    expect(s.meanNet).toBeCloseTo(0.03, 12);
    expect(s.ci95![0]).toBeCloseTo(0.03 - 0.01963, 4);
    expect(s.ci95![1]).toBeCloseTo(0.03 + 0.01963, 4);
    expect(s.regime).toBeNull();
    expect(s.tier).toBeNull();
  });
  test("n < 5 has no interval; hit means net > 0 strictly", () => {
    const [s] = groupStats([row(0.02), row(0), row(-0.01), row(0.01)]);
    expect(s.n).toBe(4);
    expect(s.hitRate).toBe(0.5);
    expect(s.meanNet).toBeCloseTo(0.005, 12);
    expect(s.ci95).toBeNull();
  });
  test("df above 30 uses 1.96", () => {
    const xs = Array.from({ length: 40 }, (_, i) => (i % 2 ? 0.01 : -0.01)); // mean 0, sd = .01 * sqrt(40/39)
    const [s] = groupStats(xs.map((x) => row(x)));
    const h = (1.96 * 0.01 * Math.sqrt(40 / 39)) / Math.sqrt(40);
    expect(s.ci95![1]).toBeCloseTo(h, 10);
  });
  test("groups by setupKind and horizon; regime and tier only when asked", () => {
    const rows = [row(0.01), row(0.03, { horizon: "4h" }), row(0.05, { setupKind: "fade" }), row(0.07, { regime: "chop", liquidityTier: 3 })];
    expect(groupStats(rows)).toHaveLength(3);
    const split = groupStats(rows, { regime: true, tier: true });
    expect(split).toHaveLength(4);
    expect(split.find((s) => s.regime === "chop")!.tier).toBe(3);
  });
  test("non-finite returns are skipped; empty input is empty", () => {
    expect(groupStats([row(NaN)])).toEqual([]);
    expect(groupStats([])).toEqual([]);
  });
});
