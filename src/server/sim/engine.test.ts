import { describe, expect, test } from "bun:test";
import { simulate, NoPriceDataError, type DailyClose } from "./engine";
import type { BranchConfig } from "../../shared/types";

const DAY = 86400000;
const d0 = Date.parse("2024-01-01");
const d1 = d0 + DAY;
const d2 = d0 + 2 * DAY;

function candles(prices: number[], start = d0): DailyClose[] {
  return prices.map((c, i) => ({ ts: start + i * DAY, c }));
}

describe("simulate", () => {
  test("single-asset buy-and-hold equity curve", () => {
    const config: BranchConfig = {
      startDate: "2024-01-01",
      initialCapitalUsd: 1000,
      allocations: [{ coin: "BTC", weightPct: 100 }],
      rebalance: "none",
    };
    const result = simulate(config, { BTC: candles([100, 110, 121]) });

    expect(result.equity).toEqual([
      { ts: d0, value: 1000 },
      { ts: d1, value: 1100 },
      { ts: d2, value: 1210 },
    ]);
    // portfolio *is* 100% BTC, so it tracks the BTC benchmark exactly.
    expect(result.benchmarks.btc).toEqual(result.equity);
    expect(result.stats.finalValue).toBe(1210);
    expect(result.stats.vsBtcPct).toBeCloseTo(0, 6);
    expect(result.stats.vsUsdcPct).toBeCloseTo(21, 6);
  });

  test("60/40 two-asset monthly rebalance (hand-computable 3-point series)", () => {
    const jan31 = Date.parse("2024-01-31");
    const feb01 = Date.parse("2024-02-01");
    const feb02 = Date.parse("2024-02-02");
    const config: BranchConfig = {
      startDate: "2024-01-31",
      initialCapitalUsd: 1000,
      allocations: [
        { coin: "ETH", weightPct: 60 },
        { coin: "USDC", weightPct: 40 },
      ],
      rebalance: "monthly",
    };
    const result = simulate(config, {
      // flat BTC candles: only needed to derive the grid + benchmark.
      BTC: [
        { ts: jan31, c: 100 },
        { ts: feb01, c: 100 },
        { ts: feb02, c: 100 },
      ],
      ETH: [
        { ts: jan31, c: 100 },
        { ts: feb01, c: 110 },
        { ts: feb02, c: 121 },
      ],
    });

    expect(result.equity[0]!.value).toBeCloseTo(1000, 6);
    expect(result.equity[1]!.value).toBeCloseTo(1060, 6); // month rolls over -> rebalance
    expect(result.equity[2]!.value).toBeCloseTo(1123.6, 6); // same month -> no rebalance
  });

  test("60/40 two-asset weekly rebalance (hand-computable 3-point series)", () => {
    // Weekly buckets are epoch-anchored (floor(ts / 7 days)), and the Unix
    // epoch was a Thursday, so the bucket boundary falls on Thu 00:00 UTC.
    // 2024-01-03 is a Wednesday and 2024-01-04 is the following Thursday,
    // so the rebalance fires crossing day0->day1 here — same timing as the
    // monthly test above, so the expected values are identical.
    const jan03 = Date.parse("2024-01-03");
    const jan04 = Date.parse("2024-01-04");
    const jan05 = Date.parse("2024-01-05");
    const config: BranchConfig = {
      startDate: "2024-01-03",
      initialCapitalUsd: 1000,
      allocations: [
        { coin: "ETH", weightPct: 60 },
        { coin: "USDC", weightPct: 40 },
      ],
      rebalance: "weekly",
    };
    const result = simulate(config, {
      BTC: [
        { ts: jan03, c: 100 },
        { ts: jan04, c: 100 },
        { ts: jan05, c: 100 },
      ],
      ETH: [
        { ts: jan03, c: 100 },
        { ts: jan04, c: 110 },
        { ts: jan05, c: 121 },
      ],
    });

    expect(result.equity[0]!.value).toBeCloseTo(1000, 6);
    expect(result.equity[1]!.value).toBeCloseTo(1060, 6); // Wed->Thu crosses the epoch-week boundary -> rebalance
    expect(result.equity[2]!.value).toBeCloseTo(1123.6, 6); // still Thursday's week -> no rebalance
  });

  test("threshold5pct rebalance triggers only once drift exceeds 5pp", () => {
    const config: BranchConfig = {
      startDate: "2024-01-01",
      initialCapitalUsd: 1000,
      allocations: [
        { coin: "BTC", weightPct: 50 },
        { coin: "USDC", weightPct: 50 },
      ],
      rebalance: "threshold5pct",
    };
    const result = simulate(config, { BTC: candles([100, 116, 130, 143]) });

    expect(result.equity[1]!.value).toBeCloseTo(1080, 6); // 3.7pp drift, no rebalance
    expect(result.equity[2]!.value).toBeCloseTo(1150, 6); // 6.5pp drift -> rebalances (total unchanged)
    expect(result.equity[3]!.value).toBeCloseTo(1207.5, 6); // post-rebalance qty carries fwd
    expect(result.equity[3]!.value).not.toBeCloseTo(1215, 1); // naive (unrebalanced) hold value
  });

  test("max drawdown on a known series", () => {
    const config: BranchConfig = {
      startDate: "2024-01-01",
      initialCapitalUsd: 100,
      allocations: [{ coin: "BTC", weightPct: 100 }],
      rebalance: "none",
    };
    const result = simulate(config, { BTC: candles([100, 120, 90, 110, 80, 150]) });
    expect(result.stats.maxDrawdownPct).toBeCloseTo(33.3333333, 5);
  });

  test("CAGR over an exact 2-year span", () => {
    const twoYearsLater = d0 + 730 * DAY;
    const config: BranchConfig = {
      startDate: "2024-01-01",
      initialCapitalUsd: 1000,
      allocations: [{ coin: "BTC", weightPct: 100 }],
      rebalance: "none",
    };
    const result = simulate(config, {
      BTC: [
        { ts: d0, c: 100 },
        { ts: twoYearsLater, c: 121 },
      ],
    });
    expect(result.stats.cagrPct).toBeCloseTo(10, 6);
  });

  test("stablecoin allocation stays flat $1 and benchmarks compute independently", () => {
    const config: BranchConfig = {
      startDate: "2024-01-01",
      initialCapitalUsd: 500,
      allocations: [{ coin: "USDC", weightPct: 100 }],
      rebalance: "none",
    };
    const result = simulate(config, { BTC: candles([100, 200, 50]) });

    expect(result.equity).toEqual([
      { ts: d0, value: 500 },
      { ts: d1, value: 500 },
      { ts: d2, value: 500 },
    ]);
    expect(result.benchmarks.btc).toEqual([
      { ts: d0, value: 500 },
      { ts: d1, value: 1000 },
      { ts: d2, value: 250 },
    ]);
    expect(result.benchmarks.usdc).toEqual([
      { ts: d0, value: 500 },
      { ts: d1, value: 500 },
      { ts: d2, value: 500 },
    ]);
  });

  test("allocation coin with an empty candle series fails fast instead of corrupting the result with NaN", () => {
    const config: BranchConfig = {
      startDate: "2024-01-01",
      initialCapitalUsd: 1000,
      allocations: [
        { coin: "BTC", weightPct: 50 },
        { coin: "ETH", weightPct: 50 },
      ],
      rebalance: "none",
    };
    // ETH resolves to [] — e.g. both backfill sources failed for it.
    expect(() => simulate(config, { BTC: candles([100, 110]), ETH: [] })).toThrow(NoPriceDataError);
    expect(() => simulate(config, { BTC: candles([100, 110]) })).toThrow(NoPriceDataError);
  });

  test("missing-candle-day carries forward the last known close", () => {
    const d3 = d0 + 3 * DAY;
    const config: BranchConfig = {
      startDate: "2024-01-01",
      initialCapitalUsd: 1000,
      allocations: [{ coin: "ETH", weightPct: 100 }],
      rebalance: "none",
    };
    const result = simulate(config, {
      BTC: candles([100, 100, 100, 100]), // defines the 4-day grid
      ETH: [
        { ts: d0, c: 100 },
        // d1 missing -> carry forward 100
        { ts: d2, c: 100 },
        { ts: d3, c: 110 },
      ],
    });

    expect(result.equity).toEqual([
      { ts: d0, value: 1000 },
      { ts: d1, value: 1000 },
      { ts: d2, value: 1000 },
      { ts: d3, value: 1100 },
    ]);
  });
});
