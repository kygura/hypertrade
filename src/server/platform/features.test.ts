import { describe, expect, test } from "bun:test";
import { computeFeatures, DEFAULT_THRESHOLDS, liquidityTiers, setupsFor, type RingPoint } from "./features.js";

const MIN = 60_000;
const NOW = Date.UTC(2026, 9, 15, 12);

/** n 1-min points ending at NOW: deterministic ±0.05% zig-zag in price, flat OI/volume/funding unless overridden. */
function ring(n: number, over: (i: number, p: RingPoint) => Partial<RingPoint> = () => ({})): RingPoint[] {
  let mark = 100;
  return Array.from({ length: n }, (_, i) => {
    mark *= Math.exp(i % 2 ? -0.0005 : 0.0005 + (i % 7 === 0 ? 0.0002 : 0));
    const p = { ts: NOW - (n - 1 - i) * MIN, mark, oiUsd: 1e8 + (i % 5) * 1e5, funding: 1e-5 + (i % 3) * 1e-6, dayNtlVlm: 5e8 + (i % 11) * 1e6 };
    return { ...p, ...over(i, p) };
  });
}

const noNaN = (o: Record<string, number | null>) => Object.values(o).forEach((v) => expect(v === null || Number.isFinite(v)).toBe(true));

describe("computeFeatures", () => {
  test("empty and thin history: every history feature null, no NaN", () => {
    for (const h of [[], ring(1), ring(20)]) {
      const fv = computeFeatures(h, NOW);
      noNaN(fv.features);
      for (const k of ["ret15mZ", "priceAccelZ", "oiChg1hZ", "fundingZ7d", "fundingPctile14d", "volRatio1hZ", "rvExpansion"]) expect(fv.features[k]).toBeNull();
    }
  });

  test("full day: z features exist and a quiet series reads near zero", () => {
    const fv = computeFeatures(ring(24 * 60), NOW);
    noNaN(fv.features);
    expect(fv.features.ret15mZ).not.toBeNull();
    expect(Math.abs(fv.features.ret15mZ!)).toBeLessThan(3);
    expect(fv.features.rvExpansion).toBeCloseTo(1, 0);
    expect(fv.inputs.sigma1h as number).toBeGreaterThan(0);
  });

  test("a late pump with OI build lights ret15m, accel, OI and volume z", () => {
    const n = 24 * 60;
    const fv = computeFeatures(
      ring(n, (i, p) => (i >= n - 15 ? { mark: p.mark * (1 + 0.03 * ((i - (n - 16)) / 15)), oiUsd: p.oiUsd * 1.05, dayNtlVlm: p.dayNtlVlm * 1.2 } : {})),
      NOW,
    );
    expect(fv.features.ret15mZ!).toBeGreaterThan(3);
    expect(fv.features.priceAccelZ!).toBeGreaterThan(1);
    expect(fv.features.oiChg1hZ!).toBeGreaterThan(1);
    expect(fv.features.volRatio1hZ!).toBeGreaterThan(1);
    expect(fv.features.rvExpansion!).toBeGreaterThan(1);
  });

  test("funding percentile: current funding at the top of 14 d reads ~1", () => {
    const n = 14 * 24 * 60;
    const h = ring(n, (i) => ({ funding: 1e-5 + (i / n) * 1e-4 }));
    const fv = computeFeatures(h, NOW);
    expect(fv.features.fundingPctile14d).toBe(1);
    expect(computeFeatures(h.slice(0, 30), NOW).features.fundingPctile14d).toBeNull();
  });

  test("liqPressure and book features only when given", () => {
    const h = ring(24 * 60);
    expect(computeFeatures(h, NOW).features.liqPressure).toBeNull();
    expect(computeFeatures(h, NOW).features.spreadBps).toBeNull();
    const book = { bids: [{ px: 99.9, sz: 100 }], asks: [{ px: 100.1, sz: 100 }] };
    const fv = computeFeatures(h, NOW, { liqNearUsd: 5e6, book });
    expect(fv.features.liqPressure).toBeCloseTo(5e6 / (fv.inputs.oiUsd as number), 9);
    expect(fv.features.spreadBps).toBeCloseTo(20, 6);
    expect(fv.features.depthUsd).toBeCloseTo(99.9 * 100 + 100.1 * 100, 6);
    expect(computeFeatures(h, NOW, { liqNearUsd: NaN }).features.liqPressure).toBeNull();
  });

  test("junk points (NaN, zero mark, future) are ignored", () => {
    const h = [...ring(24 * 60), { ts: NOW, mark: NaN, oiUsd: NaN, funding: NaN, dayNtlVlm: NaN }, { ts: NOW + MIN, mark: 1, oiUsd: 1, funding: 0, dayNtlVlm: 1 }];
    noNaN(computeFeatures(h, NOW).features);
  });
});

describe("liquidityTiers", () => {
  test("terciles by volume; junk volume is thinnest", () => {
    const t = liquidityTiers([
      { coin: "A", dayNtlVlm: 9e9 }, { coin: "B", dayNtlVlm: 8e9 }, { coin: "C", dayNtlVlm: 5e9 },
      { coin: "D", dayNtlVlm: 4e9 }, { coin: "E", dayNtlVlm: 1e6 }, { coin: "F", dayNtlVlm: NaN },
    ]);
    expect(t).toEqual({ A: 1, B: 1, C: 2, D: 2, E: 3, F: 3 });
  });
});

describe("setupsFor", () => {
  const base = (features: Record<string, number | null>, inputs: Record<string, unknown> = {}) => ({
    features,
    inputs: { mark: 100, funding: 1e-4, sigma1h: 0.01, ...inputs },
  });
  const kinds = (fv: ReturnType<typeof base>, tier: 1 | 2 | 3 = 1) => setupsFor(fv, tier).map((s) => s.setupKind);

  test("crowded_long: short, stop above, target below", () => {
    const s = setupsFor(base({ fundingZ7d: 2.5, oiChg1hZ: 1.5, ret15mZ: 0.2 }), 1);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ setupKind: "crowded_long", direction: "short" });
    expect(s[0]!.stopPx).toBeCloseTo(101.5, 9);
    expect(s[0]!.targetPx).toBeCloseTo(98, 9);
    expect(s[0]!.invalidationPx).toBe(s[0]!.stopPx);
  });

  test("negative_funding_squeeze: long", () => {
    const s = setupsFor(base({ fundingZ7d: -2, oiChg1hZ: 1.5, ret15mZ: 0 }, { funding: -1e-4 }), 1);
    expect(s.map((x) => x.setupKind)).toEqual(["negative_funding_squeeze"]);
    expect(s[0]!.stopPx).toBeLessThan(100);
    expect(s[0]!.targetPx).toBeGreaterThan(100);
  });

  test("deleveraging_washout: long after a flush", () => {
    expect(kinds(base({ oiChg1hZ: -2, ret15mZ: -2.5, rvExpansion: 2 }))).toEqual(["deleveraging_washout"]);
  });

  test("vol_expansion_breakout follows the sign of the move", () => {
    const up = setupsFor(base({ rvExpansion: 2, ret15mZ: 2.5, priceAccelZ: 1, volRatio1hZ: 2 }), 1);
    const dn = setupsFor(base({ rvExpansion: 2, ret15mZ: -2.5, priceAccelZ: -1, volRatio1hZ: 2 }), 1);
    expect(up[0]).toMatchObject({ setupKind: "vol_expansion_breakout", direction: "long" });
    expect(dn[0]).toMatchObject({ setupKind: "vol_expansion_breakout", direction: "short" });
  });

  test("tier thresholds: thinner tiers need more", () => {
    const f = base({ fundingZ7d: 2.1, oiChg1hZ: 1.1, ret15mZ: 0 });
    expect(kinds(f, 1)).toEqual(["crowded_long"]);
    expect(kinds(f, 2)).toEqual([]);
    expect(kinds(f, 3)).toEqual([]);
    expect(setupsFor(f, 3, { ...DEFAULT_THRESHOLDS, 3: DEFAULT_THRESHOLDS[1] })).toHaveLength(1);
  });

  test("unknown features, no vol or no mark: no setups", () => {
    expect(kinds(base({}))).toEqual([]);
    expect(kinds(base({ fundingZ7d: 3, oiChg1hZ: 2, ret15mZ: 0 }, { sigma1h: null }))).toEqual([]);
    expect(kinds(base({ fundingZ7d: 3, oiChg1hZ: 2, ret15mZ: 0 }, { mark: null }))).toEqual([]);
  });

  test("a stop that would go non-positive is dropped", () => {
    expect(kinds(base({ fundingZ7d: -2, oiChg1hZ: 1.5, ret15mZ: 0 }, { funding: -1e-4, sigma1h: 0.9 }))).toEqual([]);
  });
});
