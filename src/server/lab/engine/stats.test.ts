import { describe, expect, test } from "bun:test";
import { deflatedSharpe, deflatedSharpeOf, expectedMaxSharpe, moments, normCdf, normInv } from "./stats.js";
import { gauss, mulberry32 } from "./rng.js";

describe("stats", () => {
  test("normal cdf and inverse round-trip", () => {
    for (const p of [0.001, 0.05, 0.5, 0.9, 0.999]) expect(normCdf(normInv(p))).toBeCloseTo(p, 5);
    expect(normInv(0.975)).toBeCloseTo(1.959964, 5);
    expect(normCdf(0)).toBeCloseTo(0.5, 7);
  });

  test("moments: skew 0 and raw kurtosis 3 for symmetric/flat input; sign of skew", () => {
    expect(moments(Float64Array.of(1, 1, 1, 1, 1))).toEqual({ skew: 0, kurt: 3 });
    const m = moments(Float64Array.of(-1, 1, -1, 1));
    expect(m.skew).toBeCloseTo(0, 12);
    expect(m.kurt).toBeCloseTo(1, 12);
    expect(moments(Float64Array.of(0, 0, 0, 0, 10)).skew).toBeGreaterThan(0);
  });

  test("more trials raise the bar and lower the deflated Sharpe", () => {
    expect(expectedMaxSharpe(1, 0.0004)).toBe(0);
    expect(expectedMaxSharpe(1000, 0.0004)).toBeGreaterThan(expectedMaxSharpe(10, 0.0004));
    const few = deflatedSharpe(0.06, 2000, 0, 3, 10, 0.0004);
    const many = deflatedSharpe(0.06, 2000, 0, 3, 10_000, 0.0004);
    expect(many!).toBeLessThan(few!);
  });

  test("undefined (null), not 0, when skew/kurtosis leave no standard error", () => {
    // 1 − skew·SR + (kurt − 1)/4·SR² = 1 − 3 + 0.5 < 0
    expect(deflatedSharpe(1, 100, 3, 3, 1, 0.01)).toBeNull();
    expect(deflatedSharpe(0.05, 100, 3, 3, 1, 0.01)).not.toBeNull();
  });

  test("deflatedSharpeOf: a strong track survives many trials, noise does not", () => {
    const rng = mulberry32(3);
    const edge = Float64Array.from({ length: 1500 }, () => 0.004 + 0.02 * gauss(rng)); // ~3.8 annualised
    const noise = Float64Array.from({ length: 1500 }, () => 0.02 * gauss(rng));
    expect(deflatedSharpeOf(edge, 1)).toBeGreaterThan(0.99);
    expect(deflatedSharpeOf(edge, 5000)).toBeGreaterThan(0.95);
    expect(deflatedSharpeOf(noise, 5000)).toBeLessThan(0.5);
    // N = 1 is the probabilistic Sharpe against zero.
    expect(deflatedSharpeOf(noise, 1)!).toBeLessThan(deflatedSharpeOf(edge, 1)!);
    expect(deflatedSharpeOf(new Float64Array(2), 1)).toBeNull();
  });
});
