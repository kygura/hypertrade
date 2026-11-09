import { describe, expect, test } from "bun:test";
import { atr, atrAt, fundingAprFrac, fundingAprPct, mad, mean, median, quantile, robustSigma, sdPopulation, sdSample, zPopulation, zRobust, zSample } from "./signalMath.js";

describe("funding APR", () => {
  test.each([
    [0, 0, 0],
    [0.0000125, 0.1095, 10.95],
    [-0.0001, -0.876, -87.6],
  ])("hourly %p -> frac %p, pct %p", (h, frac, pct) => {
    expect(fundingAprFrac(h)).toBeCloseTo(frac, 10);
    expect(fundingAprPct(h)).toBeCloseTo(pct, 8);
  });
  test("pct is the same arithmetic as the old inlined expression", () => {
    for (const h of [1.25e-5, 3.3e-4, -7.7e-6]) expect(fundingAprPct(h)).toBe(h * 24 * 365 * 100);
  });
});

describe("median / mad / quantile", () => {
  test.each([
    [[3, 1, 2], 2],
    [[4, 1, 3, 2], 2.5],
    [[5], 5],
  ])("median %p = %p", (xs, want) => expect(median(xs)).toBe(want));
  test("median of empty is NaN", () => expect(median([])).toBeNaN());
  test("mad is the unscaled median absolute deviation", () => expect(mad([1, 2, 3, 4, 100])).toBe(1));
  test.each([
    [[1, 2, 3, 4, 5], 0, 1],
    [[1, 2, 3, 4, 5], 0.5, 3],
    [[1, 2, 3, 4, 5], 0.1, 1.4],
    [[1, 2, 3, 4, 5], 1, 5],
    [[1, 2, 3, 4, 5], 2, 5], // clamped
    [[7], 0.3, 7],
  ])("quantile %p at %p = %p", (s, q, want) => expect(quantile(s, q)).toBeCloseTo(want, 12));
  test("quantile of empty is NaN", () => expect(quantile([], 0.5)).toBeNaN());
});

describe("dispersion and z variants", () => {
  const base = [1, 2, 3, 4, 5];
  test("sample vs population sd", () => {
    expect(sdSample(base)).toBeCloseTo(Math.sqrt(2.5), 12);
    expect(sdPopulation(base)).toBeCloseTo(Math.sqrt(2), 12);
    expect(sdPopulation([1])).toBeNaN();
  });
  test("mean of empty is NaN", () => expect(mean([])).toBeNaN());
  test("zSample uses n-1 and is null on a flat base", () => {
    expect(zSample(6, base)).toBeCloseTo(3 / Math.sqrt(2.5), 12);
    expect(zSample(6, [2, 2, 2])).toBeNull();
    expect(zSample(6, [2])).toBeNull();
  });
  test("zPopulation uses n, enforces min obs, null on flat", () => {
    expect(zPopulation(6, base, 5)).toBeCloseTo(3 / Math.sqrt(2), 12);
    expect(zPopulation(6, base, 6)).toBeNull();
    expect(zPopulation(6, [2, 2, 2], 3)).toBeNull();
  });
  test("zRobust uses median/MAD with a sigma floor", () => {
    expect(robustSigma([1, 2, 3, 4, 100], 0)).toBeCloseTo(1.4826, 12);
    expect(robustSigma([5, 5, 5], 0.5)).toBe(0.5);
    expect(zRobust(10, [1, 2, 3, 4, 100], 0)).toBeCloseTo(7 / 1.4826, 12);
    expect(zRobust(1, [5, 5, 5], 0.5)).toBe(-8);
  });
});

describe("atr", () => {
  const bars = [
    { h: 10, l: 8, c: 9 },
    { h: 11, l: 9, c: 10 }, // TR 2
    { h: 12, l: 10, c: 11 }, // TR 2
    { h: 15, l: 11, c: 14 }, // TR 4
  ];
  test("mean true range of the last period bars", () => {
    expect(atr(bars, 3)).toBeCloseTo(8 / 3, 12);
    expect(atr(bars, 2)).toBe(3);
  });
  test("null until period + 1 bars", () => {
    expect(atr(bars, 4)).toBeNull();
    expect(atr(bars.slice(0, 2), 2)).toBeNull();
  });
  test("a gap counts: true range uses the previous close", () => {
    expect(atr([{ h: 10, l: 9, c: 9.5 }, { h: 14, l: 13, c: 13.5 }], 1)).toBe(4.5);
  });
  test("array form matches and propagates NaN", () => {
    const h = bars.map((b) => b.h), l = bars.map((b) => b.l), c = bars.map((b) => b.c);
    expect(atrAt(h, l, c, 3, 3)).toBe(atr(bars, 3)!);
    expect(atrAt(h, l, c, 2, 3)).toBeNaN();
    expect(atrAt(h, [l[0]!, l[1]!, NaN, l[3]!], c, 3, 3)).toBeNaN();
  });
});
