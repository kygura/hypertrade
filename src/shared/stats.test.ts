import { describe, expect, test } from "bun:test";
import {
  pctChange, sma, zscore, valueAtOrBefore, rocSeries, rollingZ, smaSeries, rollingSum,
  deltaSeries, runningMaxSeries, logReturnStdevSeries, rollingPercentileSeries,
} from "./stats";

const DAY = 86400;

describe("stats", () => {
  test("pctChange", () => {
    expect(pctChange(110, 100)).toBeCloseTo(10);
    expect(pctChange(90, 100)).toBeCloseTo(-10);
    expect(pctChange(5, 0)).toBeNull();
    expect(pctChange(-90, -100)).toBeCloseTo(10);   // rising from a negative base is positive
    expect(pctChange(-110, -100)).toBeCloseTo(-10); // falling from a negative base is negative
  });

  test("sma", () => {
    expect(sma([1, 2, 3, 4], 2)).toBe(3.5);
    expect(sma([1], 2)).toBeNull();
  });

  test("zscore", () => {
    const sample = Array.from({ length: 21 }, (_, i) => i); // mean 10, std ~6.06
    const z = zscore(16.06, sample);
    expect(z).not.toBeNull();
    expect(z!).toBeCloseTo(1, 1);
    expect(zscore(5, [1, 2, 3])).toBeNull();          // sample too small
    expect(zscore(5, Array(25).fill(7))).toBeNull();  // zero std
  });

  test("valueAtOrBefore", () => {
    const obs = [{ ts: 100, value: 1 }, { ts: 200, value: 2 }];
    expect(valueAtOrBefore(obs, 150)).toBe(1);
    expect(valueAtOrBefore(obs, 200)).toBe(2);
    expect(valueAtOrBefore(obs, 50)).toBeNull();
  });

  test("rocSeries computes lagged pct change", () => {
    const obs = [
      { ts: 0, value: 100 }, { ts: 7 * DAY, value: 105 }, { ts: 14 * DAY, value: 110 },
    ];
    const roc = rocSeries(obs, 7 * DAY);
    expect(roc).toEqual([
      { ts: 7 * DAY, value: 5 },
      { ts: 14 * DAY, value: expect.closeTo((110 / 105 - 1) * 100, 5) as unknown as number },
    ]);
  });

  test("rollingZ emits z once window has enough points", () => {
    const obs = Array.from({ length: 30 }, (_, i) => ({ ts: i * DAY, value: i < 29 ? 10 : 20 }));
    const z = rollingZ(obs, 40 * DAY, 20);
    const last = z[z.length - 1]!;
    expect(last.ts).toBe(29 * DAY);
    expect(last.value).toBeGreaterThan(3); // 20 is a big outlier vs constant 10s
  });

  test("smaSeries", () => {
    const obs = [1, 2, 3, 4].map((v, i) => ({ ts: i, value: v }));
    expect(smaSeries(obs, 2)).toEqual([
      { ts: 1, value: 1.5 }, { ts: 2, value: 2.5 }, { ts: 3, value: 3.5 },
    ]);
  });

  test("rollingSum", () => {
    const obs = [
      { ts: 0, value: 1 }, { ts: DAY, value: 2 }, { ts: 2 * DAY, value: 4 },
    ];
    const sums = rollingSum(obs, 2 * DAY);
    expect(sums).toEqual([
      { ts: 0, value: 1 }, { ts: DAY, value: 3 }, { ts: 2 * DAY, value: 6 },
    ]);
  });

  test("deltaSeries computes absolute lagged change, skips unalignable head", () => {
    const obs = [
      { ts: 0, value: 100 }, { ts: 7 * DAY, value: 105 }, { ts: 14 * DAY, value: 103 },
    ];
    expect(deltaSeries(obs, 7 * DAY)).toEqual([
      { ts: 7 * DAY, value: 5 },   // 105 − 100
      { ts: 14 * DAY, value: -2 }, // 103 − 105
    ]);
  });

  test("runningMaxSeries carries the all-time-high forward", () => {
    const obs = [10, 12, 11, 15, 9].map((v, i) => ({ ts: i, value: v }));
    expect(runningMaxSeries(obs)).toEqual([
      { ts: 0, value: 10 }, { ts: 1, value: 12 }, { ts: 2, value: 12 },
      { ts: 3, value: 15 }, { ts: 4, value: 15 },
    ]);
  });

  test("logReturnStdevSeries: population stdev of last window log returns", () => {
    // prices 1→2→4→4: log returns ln2, ln2, 0
    const obs = [1, 2, 4, 4].map((v, i) => ({ ts: i, value: v }));
    const out = logReturnStdevSeries(obs, 2);
    expect(out.length).toBe(2);
    expect(out[0]!.ts).toBe(2);
    expect(out[0]!.value).toBeCloseTo(0, 10);        // [ln2, ln2] → 0
    expect(out[1]!.ts).toBe(3);
    expect(out[1]!.value).toBeCloseTo(Math.LN2 / 2, 10); // [ln2, 0] → ln2/2
  });

  test("logReturnStdevSeries skips non-positive prices (log undefined)", () => {
    const obs = [1, 2, 0, 4].map((v, i) => ({ ts: i, value: v }));
    // only one valid return (1→2); window 2 cannot fill → empty
    expect(logReturnStdevSeries(obs, 2)).toEqual([]);
  });

  test("rollingPercentileSeries ranks each point in its trailing window", () => {
    const obs = [30, 10, 20, 40].map((v, i) => ({ ts: i * DAY, value: v }));
    const out = rollingPercentileSeries(obs, 100 * DAY, 2);
    expect(out.length).toBe(3); // first point below minSample
    expect(out[0]!).toEqual({ ts: DAY, value: 50 });          // [30,10], 10 is min
    expect(out[1]!.value).toBeCloseTo((2 / 3) * 100, 6);      // [30,10,20], 20 beats 10 & itself
    expect(out[2]!).toEqual({ ts: 3 * DAY, value: 100 });     // 40 is the window max
  });

  test("rollingPercentileSeries evicts points older than the window", () => {
    const obs = [
      { ts: 0, value: 999 }, { ts: DAY, value: 10 },
      { ts: 2 * DAY, value: 20 }, { ts: 3 * DAY, value: 15 },
    ];
    const out = rollingPercentileSeries(obs, 2 * DAY, 2);
    const last = out[out.length - 1]!;
    expect(last.ts).toBe(3 * DAY);
    // 999 (day 0) is evicted; window [10,20,15], 15 ≤ {10,15} → 2/3
    expect(last.value).toBeCloseTo((2 / 3) * 100, 6);
  });
});
