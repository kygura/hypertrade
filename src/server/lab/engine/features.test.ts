import { describe, expect, test } from "bun:test";
import { TRANSFORMS } from "../types.js";
import { buildFeatures, featureId, featureLookback, featureSpecs, parseFeatureId, transformSeries, VCHG_VOL_WINDOW } from "./features.js";
import { gauss, mulberry32 } from "./rng.js";

function series(seed: number, n: number, nanEvery = 0): number[] {
  const rng = mulberry32(seed);
  let w = 100;
  return Array.from({ length: n }, (_, i) => {
    w *= 1 + 0.03 * gauss(rng);
    return nanEvery && i % nanEvery === 5 ? NaN : w;
  });
}

const same = (a: Float64Array, b: Float64Array, upto: number) => {
  for (let i = 0; i <= upto; i++) if (!Object.is(a[i], b[i])) return `differs at ${i}: ${a[i]} vs ${b[i]}`;
  return null;
};

describe("feature ids", () => {
  test("round trip, raw window 0, metric ids may contain colons", () => {
    expect(featureId({ metric: "cm:CapMVRVCur", transform: "z", window: 90 })).toBe("cm:CapMVRVCur|z|90");
    expect(featureId({ metric: "ht:funding", transform: "raw", window: 30 })).toBe("ht:funding|raw|0");
    expect(parseFeatureId("cm:CapMVRVCur|z|90")).toEqual({ metric: "cm:CapMVRVCur", transform: "z", window: 90 });
    expect(() => parseFeatureId("cm:x|nope|7")).toThrow(/unknown transform/);
    expect(() => parseFeatureId("cm:x|z|0")).toThrow(/window/);
    expect(() => parseFeatureId("garbage")).toThrow(/invalid feature id/);
  });
});

describe("transforms", () => {
  test("hand-checked values", () => {
    const x = [1, 2, 3, 4, 10];
    const z = transformSeries(x, "z", 3);
    // window [3, 4, 10]: mean 17/3, sample sd
    const m = 17 / 3;
    const sd = Math.sqrt(((3 - m) ** 2 + (4 - m) ** 2 + (10 - m) ** 2) / 2);
    expect(z[4]).toBeCloseTo((10 - m) / sd, 12);
    expect(transformSeries(x, "roc", 2)[4]).toBeCloseTo((10 - 3) / 3, 12);
    expect(transformSeries(x, "ma_ratio", 2)[4]).toBeCloseTo(10 / 7 - 1, 12);
    expect(transformSeries(x, "pctile", 5)[4]).toBe(1);
    expect(transformSeries(x, "pctile", 5)[0]).toBeNaN(); // one value < minObs
    expect(transformSeries([5, 4, 6, 3], "rsi", 3)[3]).toBeCloseTo((100 * 2) / (2 + 1 + 3), 12);
    expect(transformSeries([1, Math.E, Math.E ** 3], "vol", 2)[2]).toBeCloseTo(Math.SQRT1_2, 12);
    expect(transformSeries([1, 1, 1, 1], "z", 3)[3]).toBeNaN(); // flat window has no scale
    expect(transformSeries([1, 2, NaN, 4], "raw", 0)[2]).toBeNaN();
  });

  test("missing value at t gives NaN; sparse windows give NaN", () => {
    const x = [1, 2, 3, NaN, 5, 6];
    for (const tr of TRANSFORMS) expect(transformSeries(x, tr, 2)[3]).toBeNaN();
    const sparse = [1, NaN, NaN, NaN, NaN, NaN, 7];
    expect(transformSeries(sparse, "z", 6)[6]).toBeNaN();
  });

  test("no lookahead: changing values after t never changes features at ≤ t", () => {
    const base = series(1, 400, 17);
    for (const tr of TRANSFORMS) {
      for (const w of [2, 7, 30, 90]) {
        const a = transformSeries(base, tr, w);
        for (const cut of [50, 150, 333]) {
          const changed = base.map((v, i) => (i > cut ? (i % 3 ? v * 3 + 7 : NaN) : v));
          expect(same(a, transformSeries(changed, tr, w), cut)).toBeNull();
        }
      }
    }
  });

  test("buildFeatures expands metric × transform × window, raw once", () => {
    const n = 120;
    const t = Array.from({ length: n }, (_, i) => i * 86_400_000);
    const fs = buildFeatures({ asset: "X", t, price: series(3, n), metrics: { "a:x": series(4, n), "b:y": series(5, n) } }, ["raw", "z", "pctile"], [7, 30]);
    expect(fs.ids.length).toBe(2 * (1 + 2 * 2));
    expect(fs.ids[0]).toBe("a:x|raw|0");
    expect(fs.ids).toContain("b:y|pctile|30");
    expect(fs.columns.every((c) => c.length === n)).toBe(true);
  });

  test("vchg: the w-day log change over the trailing 30-day daily log-change sd × √w; NaN on warm-up", () => {
    const x = series(9, 80);
    const v = transformSeries(x, "vchg", 3);
    const t = 60;
    const d = Array.from({ length: VCHG_VOL_WINDOW }, (_, k) => Math.log(x[t - k]! / x[t - k - 1]!));
    const m = d.reduce((a, b) => a + b, 0) / d.length;
    const sd = Math.sqrt(d.reduce((a, b) => a + (b - m) ** 2, 0) / (d.length - 1));
    expect(v[t]).toBeCloseTo(Math.log(x[t]! / x[t - 3]!) / (sd * Math.sqrt(3)), 12);
    // Scale-free: the same path at 1/1000 of the price gives the same value.
    expect(transformSeries(x.map((p) => p / 1000), "vchg", 3)[t]).toBeCloseTo(v[t]!, 9);
    // Warm-up: 15 log changes (half the volatility window) are needed; before that NaN.
    expect(transformSeries(x, "vchg", 3)[14]).toBeNaN();
    expect(Number.isFinite(transformSeries(x, "vchg", 3)[15]!)).toBe(true);
    // Non-positive values have no log change.
    expect(transformSeries([1, 2, 0, 3, 4, 5], "vchg", 2)[4]).toBeNaN();
  });

  test("featureLookback: the last value of every transform reads only that many trailing days", () => {
    const x = series(21, 200);
    for (const tr of TRANSFORMS) {
      for (const w of tr === "raw" ? [0] : [2, 7, 20, 30, 90]) {
        const L = featureLookback({ transform: tr, window: w });
        const full = transformSeries(x, tr, w).at(-1);
        const masked = x.map((v, i) => (i < x.length - L ? NaN : v));
        expect(Object.is(transformSeries(masked, tr, w).at(-1), full)).toBe(true);
      }
    }
  });

  test("non-stationary metrics (a random walk flagged false) get no raw feature", () => {
    const n = 120;
    const t = Array.from({ length: n }, (_, i) => i * 86_400_000);
    const metrics = { "a:walk": series(4, n), "b:y": series(5, n) };
    const fs = buildFeatures({ asset: "X", t, price: series(3, n), metrics, stationary: { "a:walk": false, "b:y": true } }, ["raw", "z"], [7]);
    expect(fs.ids).toEqual(["a:walk|z|7", "b:y|raw|0", "b:y|z|7"]);
    expect(featureSpecs(["a:walk"], ["raw"], [7], { "a:walk": false })).toEqual([]);
    expect(featureSpecs(["a:walk"], ["raw"], [7])).toEqual([{ metric: "a:walk", transform: "raw", window: 0 }]);
  });
});
