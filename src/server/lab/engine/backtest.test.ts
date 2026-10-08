import { describe, expect, test } from "bun:test";
import { equityCurve, perfStats, priceReturns, quickScore, sharpeOf, simulate, zoneActivity } from "./backtest.js";

const DAY = 86_400_000;
const T0 = Date.UTC(2024, 0, 1);
const price = [100, 110, 99, 99, 108.9];
const t = price.map((_, i) => T0 + i * DAY);
const pr = priceReturns(price);
const sig = [1, 1, 0, 1, 0];

describe("backtest", () => {
  test("long: next-day position, slippage on every position change", () => {
    const seg = simulate(pr, sig, 1, 5, 100); // 1% per unit change
    // day1 +10% − entry 1%; day2 −10%; day3 flat, exit 1%; day4 +10% − entry 1%
    expect(Array.from(seg.ret).map((r) => +r.toFixed(10))).toEqual([0.09, -0.1, -0.01, 0.09]);
    expect(Array.from(seg.held)).toEqual([1, 1, 0, 1]);
    const s = perfStats(t, [seg]);
    expect(s.from).toBe("2024-01-02");
    expect(s.to).toBe("2024-01-05");
    expect(s.days).toBe(4);
    expect(s.totalReturn).toBeCloseTo(1.09 * 0.9 * 0.99 * 1.09 - 1, 12);
    expect(s.maxDrawdown).toBeCloseTo((1.09 * 0.9 * 0.99) / 1.09 - 1, 12);
    expect(s.trades).toBe(2); // second trade still open at the end
    expect(s.hitRate).toBe(0); // the closed one lost, exit cost included
    expect(s.exposure).toBe(0.75);
    expect(s.tradesPerYear).toBeCloseTo(2 / (4 / 365), 9);
    expect(s.cagr).toBeCloseTo((1 + s.totalReturn) ** (365 / 4) - 1, 6);
    const r = [0.09, -0.1, -0.01, 0.09];
    const m = r.reduce((a, b) => a + b) / 4;
    const sd = Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / 3);
    expect(s.sharpe).toBeCloseTo((m / sd) * Math.sqrt(365), 9);
    expect(quickScore(pr, Uint8Array.from(sig), 1, 100, 1, 5, "sharpe")).toBeCloseTo(s.sharpe, 9);
    expect(quickScore(pr, Uint8Array.from(sig), 1, 100, 1, 5, "return")).toBeCloseTo(s.totalReturn, 9);
  });

  test("short: inverted daily returns, same costs", () => {
    const seg = simulate(pr, sig.map((x) => -x), 1, 5, 100);
    expect(Array.from(seg.ret).map((r) => +r.toFixed(10))).toEqual([-0.11, 0.1, -0.01, -0.11]);
    expect(quickScore(pr, Uint8Array.from(sig), -1, 100, 1, 5, "return")).toBeCloseTo(perfStats(t, [seg]).totalReturn, 12);
  });

  test("hit rate counts closed winning episodes net of exit cost", () => {
    const s = perfStats(t, [simulate(pr, [1, 0, 0, 1, 1], 1, 5, 100)]);
    // trade 1: +10% − 1% entry, then −1% exit on day 2 → 1.09·0.99 > 1; trade 2 open at end
    expect(s.trades).toBe(2);
    expect(s.hitRate).toBe(1);
    expect(perfStats(t, [simulate(pr, [0, 0, 0, 0, 0], 1, 5, 100)]).hitRate).toBeNull();
  });

  test("a window without trades is flagged untested, not silently Sharpe 0", () => {
    const flat = perfStats(t, [simulate(pr, [0, 0, 0, 0, 0], 1, 5, 100)]);
    expect(flat.trades).toBe(0);
    expect(flat.sharpe).toBe(0);
    expect(flat.untested).toBe(true);
    expect(perfStats(t, [simulate(pr, sig, 1, 5, 100)]).untested).toBeUndefined();
  });

  test("zoneActivity: exposure and entries over return days, matching perfStats", () => {
    const z = zoneActivity(Uint8Array.from(sig), 1, 5);
    const s = perfStats(t, [simulate(pr, sig, 1, 5, 100)]);
    expect(z).toEqual({ exposure: s.exposure, trades: s.trades });
    // a window starts flat: an open position at its start is an entry
    expect(zoneActivity(Uint8Array.from([1, 1, 0, 1, 1]), 2, 5)).toEqual({ exposure: 2 / 3, trades: 2 });
  });

  test("a window starts flat and segments concatenate", () => {
    const a = simulate(pr, [1, 1, 1, 1, 1], 1, 3, 100);
    const b = simulate(pr, [1, 1, 1, 1, 1], 3, 5, 100);
    expect(b.ret[0]).toBeCloseTo(0 - 0.01, 12); // re-entry cost at window start
    const s = perfStats(t, [a, b]);
    expect(s.days).toBe(4);
    expect(s.from).toBe("2024-01-02");
    expect(s.to).toBe("2024-01-05");
  });

  test("missing prices give a zero return, flat series a zero Sharpe", () => {
    expect(Array.from(priceReturns([100, NaN, 100, 0, 50]))).toEqual([0, 0, 0, 0, 0]);
    expect(sharpeOf([0, 0, 0])).toBe(0);
  });

  test("equity curve starts at 1 the day before the window", () => {
    const eq = equityCurve(t, simulate(pr, sig, 1, 5, 0), simulate(pr, [1, 1, 1, 1, 1], 1, 5, 0));
    expect(eq[0]).toEqual({ t: t[0]!, strategy: 1, benchmark: 1 });
    expect(eq[eq.length - 1]!.benchmark).toBeCloseTo(1.089, 12);
  });
});
