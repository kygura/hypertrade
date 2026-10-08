import { describe, expect, test } from "bun:test";
import { simulate, NoPriceDataError, type DailyClose } from "./engine.js";
import type { BranchConfig } from "../../shared/types.js";

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

describe("simulate — perp legs and DCA", () => {
  const flatBtc = (n: number, start = d0) => candles(Array(n).fill(100), start);

  test("explicit long/1x allocation is a spot leg: identical to the old shape", () => {
    const base: BranchConfig = {
      startDate: "2024-01-01",
      initialCapitalUsd: 1000,
      allocations: [{ coin: "BTC", weightPct: 50 }, { coin: "USDC", weightPct: 50 }],
      rebalance: "threshold5pct",
    };
    const explicit: BranchConfig = {
      ...base,
      allocations: [{ coin: "BTC", weightPct: 50, side: "long", leverage: 1 }, { coin: "USDC", weightPct: 50 }],
    };
    const btc = { BTC: candles([100, 116, 130, 143]) };
    expect(simulate(explicit, btc)).toEqual(simulate(base, btc));
  });

  test("short 1x gains when price falls", () => {
    const config: BranchConfig = {
      startDate: "2024-01-01",
      initialCapitalUsd: 1000,
      allocations: [{ coin: "ETH", weightPct: 100, side: "short" }],
      rebalance: "none",
    };
    const r = simulate(config, { BTC: flatBtc(3), ETH: candles([100, 90, 80]) });
    // pnl = -1 * 1000 * (px/100 - 1)
    expect(r.equity.map((p) => p.value)).toEqual([1000, 1100, 1200]);
  });

  test("long 3x pnl is 3x the price move on the margin", () => {
    const config: BranchConfig = {
      startDate: "2024-01-01",
      initialCapitalUsd: 1000,
      allocations: [{ coin: "ETH", weightPct: 100, leverage: 3 }],
      rebalance: "none",
    };
    const r = simulate(config, { BTC: flatBtc(3), ETH: candles([100, 110, 105]) });
    expect(r.equity[1]!.value).toBeCloseTo(1300, 6); // 1000 + 3000 * 0.10
    expect(r.equity[2]!.value).toBeCloseTo(1150, 6); // 1000 + 3000 * 0.05
  });

  test("long 3x is liquidated by the intraday low even though the close recovers, and stays 0", () => {
    const config: BranchConfig = {
      startDate: "2024-01-01",
      initialCapitalUsd: 1000,
      allocations: [{ coin: "ETH", weightPct: 50, leverage: 3 }, { coin: "USDC", weightPct: 50 }],
      rebalance: "none",
    };
    const r = simulate(config, {
      BTC: flatBtc(3),
      ETH: [
        { ts: d0, c: 100, l: 50 }, // day-0 low precedes entry at the close: ignored
        { ts: d1, c: 100, l: 66 }, // 500 + 1500 * (66/100 - 1) = -10 -> liquidated
        { ts: d2, c: 120 }, // would be 500 + 1500 * 0.2 = 800 unliquidated
      ],
    });
    expect(r.equity.map((p) => p.value)).toEqual([1000, 500, 500]);
  });

  test("short 2x is liquidated via the intraday high (exactly 100% margin loss)", () => {
    const config: BranchConfig = {
      startDate: "2024-01-01",
      initialCapitalUsd: 1000,
      allocations: [{ coin: "ETH", weightPct: 50, side: "short", leverage: 2 }, { coin: "USDC", weightPct: 50 }],
      rebalance: "none",
    };
    const r = simulate(config, {
      BTC: flatBtc(3),
      ETH: [
        { ts: d0, c: 100 },
        { ts: d1, c: 100, h: 150 }, // 500 - 1000 * 0.5 = 0 -> liquidated
        { ts: d2, c: 50 }, // would be 500 + 1000 * 0.5 = 1000 unliquidated
      ],
    });
    expect(r.equity.map((p) => p.value)).toEqual([1000, 500, 500]);
  });

  test("a rebalance re-funds a liquidated leg at the current price", () => {
    const jan31 = Date.parse("2024-01-31");
    const feb01 = Date.parse("2024-02-01");
    const feb02 = Date.parse("2024-02-02");
    const config: BranchConfig = {
      startDate: "2024-01-31",
      initialCapitalUsd: 1000,
      allocations: [{ coin: "ETH", weightPct: 50, leverage: 3 }, { coin: "USDC", weightPct: 50 }],
      rebalance: "monthly",
    };
    const r = simulate(config, {
      BTC: flatBtc(3, jan31),
      ETH: [
        { ts: jan31, c: 100 },
        { ts: feb01, c: 100, l: 66 }, // liquidated -> 500 left, then month rolls -> margin 250 @ 100, USDC 250
        { ts: feb02, c: 110 }, // 250 + 750 * 0.1 + 250
      ],
    });
    expect(r.equity[1]!.value).toBeCloseTo(500, 6);
    expect(r.equity[2]!.value).toBeCloseTo(575, 6);
  });

  test("weekly DCA moves USDC into ETH (not in allocations), partial last buy, then stops", () => {
    // Epoch weeks roll over on Thursdays: Wed Jan 3 is day 0, each later point is a Thursday.
    const ts = ["2024-01-03", "2024-01-04", "2024-01-11", "2024-01-18", "2024-01-25", "2024-02-01"].map(Date.parse);
    const config: BranchConfig = {
      startDate: "2024-01-03",
      initialCapitalUsd: 250,
      allocations: [{ coin: "USDC", weightPct: 100 }],
      rebalance: "none",
      dca: [{ coin: "ETH", amountUsd: 100, every: "weekly" }],
    };
    const ethPx = [100, 100, 200, 50, 100, 200];
    const r = simulate(config, {
      BTC: ts.map((t) => ({ ts: t, c: 100 })),
      ETH: ts.map((t, i) => ({ ts: t, c: ethPx[i]! })),
    });
    // Equity is marked before that day's buy (a buy at the close doesn't change value).
    // Jan 4: buy 1 ETH @100 (USDC 150). Jan 11: 150+200=350, buy 0.5 @200 (USDC 50).
    // Jan 18: 50+75=125, partial buy 50 -> 1 ETH @50 (USDC 0). Jan 25: 2.5*100.
    // Feb 1: 2.5*200 = 500 — an over-buy on an empty sleeve would show 600.
    expect(r.equity.map((p) => p.value)).toEqual([250, 250, 350, 125, 250, 500]);
  });

  test("DCA coin without candle data fails fast with NoPriceDataError", () => {
    const config: BranchConfig = {
      startDate: "2024-01-01",
      initialCapitalUsd: 1000,
      allocations: [{ coin: "USDC", weightPct: 100 }],
      rebalance: "none",
      dca: [{ coin: "SOL", amountUsd: 100, every: "monthly" }],
    };
    expect(() => simulate(config, { BTC: flatBtc(2) })).toThrow(NoPriceDataError);
  });

  test("monthly rebalance leaves DCA-only coins alone (no value created from nothing)", () => {
    const ts = ["2024-01-31", "2024-02-01", "2024-03-01", "2024-04-01"].map(Date.parse);
    const config: BranchConfig = {
      startDate: "2024-01-31",
      initialCapitalUsd: 1000,
      allocations: [{ coin: "USDC", weightPct: 100 }],
      rebalance: "monthly",
      dca: [{ coin: "ETH", amountUsd: 100, every: "monthly" }],
    };
    const flat = ts.map((t) => ({ ts: t, c: 100 }));
    const r = simulate(config, { BTC: flat, ETH: flat });
    expect(r.equity.map((p) => p.value)).toEqual([1000, 1000, 1000, 1000]);
  });

  test("DCA falls back to the USDT sleeve once USDC is exhausted", () => {
    const ts = ["2024-01-31", "2024-02-01", "2024-03-01", "2024-04-01"].map(Date.parse);
    const config: BranchConfig = {
      startDate: "2024-01-31",
      initialCapitalUsd: 200,
      allocations: [{ coin: "USDC", weightPct: 25 }, { coin: "USDT", weightPct: 75 }],
      rebalance: "none",
      dca: [{ coin: "ETH", amountUsd: 100, every: "monthly" }],
    };
    const ethPx = [100, 100, 100, 200];
    const r = simulate(config, { BTC: ts.map((t) => ({ ts: t, c: 100 })), ETH: ts.map((t, i) => ({ ts: t, c: ethPx[i]! })) });
    // Feb: 50 USDC + 50 USDT -> 1 ETH. Mar: 100 USDT -> 1 ETH (sleeve empty). Apr: 2 ETH @200 = 400.
    expect(r.equity.at(-1)!.value).toBeCloseTo(400, 6);
  });

  test("liquidation without l/h falls back to the close", () => {
    const config: BranchConfig = {
      startDate: "2024-01-01",
      initialCapitalUsd: 1000,
      allocations: [{ coin: "ETH", weightPct: 50, leverage: 2 }, { coin: "USDC", weightPct: 50 }],
      rebalance: "none",
    };
    const r = simulate(config, { BTC: flatBtc(3), ETH: candles([100, 40, 100]) });
    expect(r.equity.map((p) => p.value)).toEqual([1000, 500, 500]);
  });

  test("a startDate after the last candle is an error, not a flat result", () => {
    const config: BranchConfig = {
      startDate: "2030-01-01",
      initialCapitalUsd: 1000,
      allocations: [{ coin: "BTC", weightPct: 100 }],
      rebalance: "none",
    };
    expect(() => simulate(config, { BTC: flatBtc(3) })).toThrow("no price history in range");
  });
});
