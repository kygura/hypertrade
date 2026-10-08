import { describe, expect, test } from "bun:test";
import { forwardReturns, makeLabels } from "./labels.js";

const DAY = 86_400_000;
const T0 = Date.UTC(2024, 0, 1);

describe("labels", () => {
  const price = [100, 101, 103, 102, 99, 98, 104, 107, 106, 110];
  const t = price.map((_, i) => T0 + i * DAY);

  test("forward returns stop before end", () => {
    const f = forwardReturns(price, 2, 8);
    expect(f[0]).toBeCloseTo(0.03, 12);
    expect(f[5]).toBeCloseTo(107 / 98 - 1, 12);
    expect(f[6]).toBeNaN(); // 6 + 2 = 8 reaches end
    expect(f[9]).toBeNaN();
  });

  test("long: top quantile of the search region and positive; NaN past the region", () => {
    const y = makeLabels({ t, price, horizonDays: 1, direction: "long", quantile: 0.3, end: 8 });
    const f = forwardReturns(price, 1, 8);
    const good = Array.from(f.slice(0, 7)).map((x) => x >= 0.0285);
    // f: .01 .0198 −.0097 −.0294 −.0101 .0612 .0288 → top 30% are .0612 and .0288
    expect(Array.from(y.slice(0, 7))).toEqual(good.map((g) => (g ? 1 : 0)));
    expect(Number.isNaN(y[7]!)).toBe(true);
    expect(Number.isNaN(y[9]!)).toBe(true);
  });

  test("short: bottom quantile and negative", () => {
    const y = makeLabels({ t, price, horizonDays: 1, direction: "short", quantile: 0.3, end: 8 });
    expect(Array.from(y.slice(0, 7))).toEqual([0, 0, 0, 1, 1, 0, 0]);
  });

  test("custom zones replace returns", () => {
    const y = makeLabels({ t, price, horizonDays: 1, direction: "long", quantile: 0.3, end: 8, customZones: [{ from: "2024-01-02", to: "2024-01-03" }] });
    expect(Array.from(y.slice(0, 8))).toEqual([0, 1, 1, 0, 0, 0, 0, 0]);
    expect(Number.isNaN(y[8]!)).toBe(true);
  });
});
