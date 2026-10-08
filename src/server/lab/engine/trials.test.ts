import { describe, expect, test } from "bun:test";
import { mulberry32 } from "./rng.js";
import { countClusters, effectiveTrials, zoneBits, zoneCorrelation, type ZoneBits } from "./trials.js";

const rand = (seed: number, n: number, p: number) => {
  const rng = mulberry32(seed);
  return Uint8Array.from({ length: n }, () => (rng() < p ? 1 : 0));
};
const bits = (s: Uint8Array) => zoneBits(s, 0, s.length);

describe("effective trials", () => {
  test("zoneBits and zoneCorrelation: exact overlap counts, Ochiai |A∩B|/√(|A||B|)", () => {
    const a = rand(1, 1000, 0.3);
    const b = rand(2, 1000, 0.4);
    let na = 0;
    let nb = 0;
    let both = 0;
    for (let i = 0; i < 1000; i++) {
      na += a[i]!;
      nb += b[i]!;
      both += a[i]! & b[i]!;
    }
    expect(bits(a).count).toBe(na);
    expect(zoneCorrelation(bits(a), bits(b))).toBeCloseTo(both / Math.sqrt(na * nb), 12);
    expect(zoneCorrelation(bits(a), bits(a))).toBe(1);
    expect(zoneCorrelation(bits(a), bits(new Uint8Array(1000)))).toBe(0);
    // A window of the signal: bit i is sig[from + i].
    const w = zoneBits(a, 7, 77);
    expect(w.count).toBe(a.slice(7, 77).reduce((x, y) => x + y, 0));
  });

  test("Ochiai tracks the return correlation of zero-mean strategy tracks", () => {
    const rng = mulberry32(5);
    const x = Float64Array.from({ length: 4000 }, () => rng() - 0.5);
    const a = rand(6, 4000, 0.3);
    const b = a.map((v, i) => (i % 3 === 0 ? 1 - v : v)) as Uint8Array;
    const ra = Array.from(x, (v, i) => v * a[i]!);
    const rb = Array.from(x, (v, i) => v * b[i]!);
    const mean = (r: number[]) => r.reduce((s, v) => s + v, 0) / r.length;
    const ma = mean(ra);
    const mb = mean(rb);
    let sab = 0;
    let saa = 0;
    let sbb = 0;
    for (let i = 0; i < 4000; i++) {
      sab += (ra[i]! - ma) * (rb[i]! - mb);
      saa += (ra[i]! - ma) ** 2;
      sbb += (rb[i]! - mb) ** 2;
    }
    expect(Math.abs(zoneCorrelation(bits(a), bits(b)) - sab / Math.sqrt(saa * sbb))).toBeLessThan(0.03);
  });

  test("clusters: K families of near-identical variants count K; independent variants count each", () => {
    const n = 2000;
    const families: ZoneBits[] = [];
    for (let k = 0; k < 12; k++) {
      const base = rand(100 + k, n, 0.2);
      // Threshold neighbours: the same zone with a few days flipped.
      for (let v = 0; v < 30; v++) families.push(bits(base.map((x, i) => ((i * 31 + v * 7) % 97 === 0 ? 1 - x : x)) as Uint8Array));
    }
    expect(countClusters(families)).toBe(12);
    expect(effectiveTrials(families, { seed: 1 })).toBe(12);
    const independent = Array.from({ length: 50 }, (_, k) => bits(rand(500 + k, n, 0.2)));
    expect(countClusters(independent)).toBe(50);
    // Nested zones: a 10% zone inside a 60% one correlates at √(0.1/0.6) ≈ 0.41 < 0.5: two trials.
    const wide = rand(9, n, 0.6);
    const narrow = wide.map((v, i) => (v && i % 6 === 0 ? 1 : 0)) as Uint8Array;
    expect(countClusters([bits(wide), bits(narrow)])).toBe(2);
    // Empty zones never trade and are not trials; the count is at least 1.
    expect(countClusters([bits(new Uint8Array(n))])).toBe(0);
    expect(effectiveTrials([bits(new Uint8Array(n)), bits(new Uint8Array(n))], { seed: 1 })).toBe(1);
    expect(effectiveTrials([], { seed: 1 })).toBe(1);
  });

  test("above max variants a seeded sample is clustered and scaled up, within [1, N]", () => {
    const n = 500;
    const zones = Array.from({ length: 400 }, (_, k) => bits(rand(k % 40, n, 0.2)));
    expect(countClusters(zones)).toBe(40);
    const sampled = effectiveTrials(zones, { seed: 3, max: 100 });
    expect(sampled).toBeGreaterThanOrEqual(40);
    expect(sampled).toBeLessThanOrEqual(400);
    expect(effectiveTrials(zones, { seed: 3, max: 100 })).toBe(sampled);
  });
});
