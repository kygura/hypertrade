import { describe, expect, test } from "bun:test";
import { bucketIndex } from "../../shared/platform.js";
import { aggregate, coverage } from "./liqmap.js";

const o = { mark: 100, bucketBps: 100, rangePct: 0.2 };
const long = (liquidationPx: number | null, positionValue: number) => ({ szi: 1, positionValue, liquidationPx });
const short = (liquidationPx: number | null, positionValue: number) => ({ szi: -1, positionValue, liquidationPx });

describe("aggregate", () => {
  test("longs land below mark, shorts above, sums per bucket", () => {
    const { buckets } = aggregate([long(90, 1_000_000), long(90.1, 500_000), short(110, 2_000_000)], o);
    const lb = buckets.find((b) => b.longUsd > 0)!;
    const sb = buckets.find((b) => b.shortUsd > 0)!;
    expect(lb.longUsd).toBe(1_500_000);
    expect(lb.shortUsd).toBe(0);
    expect(lb.priceHi).toBeLessThan(100);
    expect(lb.idx).toBe(bucketIndex(90, 100));
    expect(sb.shortUsd).toBe(2_000_000);
    expect(sb.priceLo).toBeGreaterThan(100);
    expect(lb.priceLo).toBeLessThanOrEqual(90);
    expect(lb.priceHi).toBeGreaterThan(90);
  });
  test("drops null liqPx, out of range, wrong side of mark, and bad values", () => {
    const { buckets } = aggregate([long(null, 1e6), long(70, 1e6), short(130, 1e6), long(105, 1e6), short(95, 1e6), long(90, NaN), long(90, -5), long(NaN, 1)], o);
    expect(buckets).toEqual([]);
  });
  test("range edge is inclusive", () => {
    expect(aggregate([long(80, 1)], o).buckets).toHaveLength(1);
  });
  test("rejects invalid options", () => {
    expect(() => aggregate([], { ...o, mark: 0 })).toThrow();
    expect(() => aggregate([], { ...o, bucketBps: NaN })).toThrow();
  });
  test("empty input", () => {
    expect(aggregate([], o)).toEqual({ buckets: [], nearestClusters: { long: null, short: null } });
  });
  test("nearest cluster: nearest bucket above max(1% of side, $250k), with distance", () => {
    const { nearestClusters: n } = aggregate([long(99, 100_000), long(95, 400_000), long(85, 5_000_000), short(101, 249_999), short(104, 300_000)], o);
    // long 99 bucket is $100k < 1% of total ($5.5M -> $55k)? 100k >= 55k but < 250k floor -> skipped
    expect(n.long!.notionalUsd).toBe(400_000);
    expect(n.long!.distancePct).toBeGreaterThan(4);
    expect(n.long!.distancePct).toBeLessThan(6);
    expect(n.short!.notionalUsd).toBe(300_000);
    expect(n.short!.distancePct).toBeGreaterThan(3);
    expect(n.short!.distancePct).toBeLessThan(4.1);
  });
  test("1% of side total beats the floor on large sides", () => {
    // total long = 60M -> min 600k; the 500k bucket near mark is skipped, the 59.5M one is picked
    const { nearestClusters: n } = aggregate([long(97, 500_000), long(85, 59_500_000)], o);
    expect(n.long!.notionalUsd).toBe(59_500_000);
    expect(n.short).toBeNull();
  });
});

describe("coverage", () => {
  test("ratio and percentiles (nearest-rank)", () => {
    const c = coverage(60e6, 100e6, 12, [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
    expect(c.ratio).toBeCloseTo(0.3, 12); // 60M tracked (longs + shorts) vs 2 × 100M one-sided OI
    expect(c.addresses).toBe(12);
    expect(c.pollAgeP50Sec).toBe(50);
    expect(c.pollAgeP90Sec).toBe(90);
  });
  test("unknown or zero OI gives ratio null (not 0%); no ages gives null percentiles; bad ages ignored", () => {
    const c = coverage(5, 0, 0, []);
    expect(c.ratio).toBeNull();
    expect(coverage(5, null, 0, []).ratio).toBeNull();
    expect(c.pollAgeP50Sec).toBeNull();
    expect(c.pollAgeP90Sec).toBeNull();
    expect(coverage(1, 2, 1, [NaN, -3, 7]).pollAgeP50Sec).toBe(7);
  });
});
