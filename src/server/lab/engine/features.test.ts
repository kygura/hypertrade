import { describe, expect, test } from "bun:test";
import { TRANSFORMS } from "../types.js";
import { buildFeatures, featureId, parseFeatureId, transformSeries } from "./features.js";
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
});
