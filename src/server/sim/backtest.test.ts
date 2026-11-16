// Backtest additions to the engine: costs, external cash flows, time-weighted stats, rolling starts.
import { describe, expect, test } from "bun:test";
import { longestDrawdownDays, monthlyReturns, riskStats, simulate, type DailyClose } from "./engine.js";
import type { BranchConfig } from "../../shared/types.js";

const DAY = 86400000;
const jan31 = Date.parse("2024-01-31");
const feb01 = Date.parse("2024-02-01");
const feb02 = Date.parse("2024-02-02");
const mar01 = Date.parse("2024-03-01");

const series = (pts: [number, number][]): DailyClose[] => pts.map(([ts, c]) => ({ ts, c }));
const flat = (tss: number[]) => series(tss.map((ts) => [ts, 100]));

describe("costs", () => {
  test("entry fee on the traded notional only", () => {
    const config: BranchConfig = {
      startDate: "2024-01-31",
      initialCapitalUsd: 1000,
      allocations: [{ coin: "BTC", weightPct: 100 }],
      rebalance: "none",
      costs: { feeBps: 10 },
    };
    const r = simulate(config, { BTC: series([[jan31, 100], [feb01, 110]]) });
    expect(r.equity[0]!.value).toBeCloseTo(999, 9);
    expect(r.equity[1]!.value).toBeCloseTo(1098.9, 9);
    expect(r.stats.feesUsd).toBeCloseTo(1, 9);
    expect(r.stats.twrPct).toBeCloseTo(9.89, 9);
  });

  test("rebalance pays the fee on the turnover back to target", () => {
    // entry: 1% of 500 ETH = 5, so 995 in: 4.975 ETH + 497.5 USDC.
    // Feb 1: ETH 120 -> 597 + 497.5 = 1094.5; target 547.25 ETH, turnover 49.75, fee 0.4975.
    const config: BranchConfig = {
      startDate: "2024-01-31",
      initialCapitalUsd: 1000,
      allocations: [{ coin: "ETH", weightPct: 50 }, { coin: "USDC", weightPct: 50 }],
      rebalance: "monthly",
      costs: { feeBps: 100 },
    };
    const r = simulate(config, { BTC: flat([jan31, feb01, feb02]), ETH: series([[jan31, 100], [feb01, 120], [feb02, 120]]) });
    expect(r.equity[1]!.value).toBeCloseTo(1094.0025, 9);
    expect(r.equity[2]!.value).toBeCloseTo(1094.0025, 9);
    expect(r.stats.feesUsd).toBeCloseTo(5.4975, 9);
  });

  test("funding: a long pays on its notional each day, a short receives", () => {
    // 36.5% APR = 0.1%/day on 2x notional: 2000 -> 2.000, then 1996 -> 1.996.
    const base = { startDate: "2024-01-31", initialCapitalUsd: 1000, rebalance: "none" as const, costs: { feeBps: 0, fundingAprPct: 36.5 } };
    const candles = { BTC: flat([jan31, feb01, feb02]), ETH: flat([jan31, feb01, feb02]) };
    const long = simulate({ ...base, allocations: [{ coin: "ETH", weightPct: 100, leverage: 2 }] }, candles);
    expect(long.equity.map((p) => p.value)).toEqual([1000, 998, expect.closeTo(996.004, 9)]);
    expect(long.stats.fundingUsd).toBeCloseTo(3.996, 9);
    const short = simulate({ ...base, allocations: [{ coin: "ETH", weightPct: 100, side: "short", leverage: 2 }] }, candles);
    expect(short.equity[2]!.value).toBeCloseTo(1004.004, 9);
    expect(short.stats.fundingUsd).toBeCloseTo(-4.004, 9);
  });

  test("no costs leaves fee and funding totals at zero", () => {
    const r = simulate(
      { startDate: "2024-01-31", initialCapitalUsd: 1000, allocations: [{ coin: "BTC", weightPct: 100 }], rebalance: "monthly" },
      { BTC: series([[jan31, 100], [feb01, 110]]) },
    );
    expect(r.stats.feesUsd).toBe(0);
    expect(r.stats.fundingUsd).toBe(0);
    expect(r.twr).toBeUndefined();
  });
});

describe("cash flows", () => {
  test("a monthly contribution is invested at the target weights; growth stats are time-weighted", () => {
    // Feb 1: 10 BTC at 110 = 1100, +100 buys 0.909 BTC -> 1200. Feb 2: 10.909 x 121 = 1320.
    // TWR: 1100/1000 x 1320/1200 = 1.21.
    const config: BranchConfig = {
      startDate: "2024-01-31",
      initialCapitalUsd: 1000,
      allocations: [{ coin: "BTC", weightPct: 100 }],
      rebalance: "none",
      cashflow: { amountUsd: 100, every: "monthly" },
    };
    const r = simulate(config, { BTC: series([[jan31, 100], [feb01, 110], [feb02, 121]]) });
    expect(r.equity.map((p) => p.value)).toEqual([1000, 1200, expect.closeTo(1320, 9)]);
    expect(r.stats.twrPct).toBeCloseTo(21, 9);
    expect(r.stats.netFlowUsd).toBe(100);
    // The BTC benchmark gets the same deposits, so a 100% BTC branch ties it.
    expect(r.stats.vsBtcPct).toBeCloseTo(0, 9);
    expect(r.twr!.at(-1)!.value).toBeCloseTo(1210, 9);
  });

  test("withdrawals sell pro rata, stop at zero, and do not count as a drawdown", () => {
    const config: BranchConfig = {
      startDate: "2024-01-31",
      initialCapitalUsd: 1000,
      allocations: [{ coin: "USDC", weightPct: 100 }],
      rebalance: "none",
      cashflow: { amountUsd: -600, every: "monthly" },
    };
    const r = simulate(config, { BTC: flat([jan31, feb01, mar01]) });
    expect(r.equity.map((p) => p.value)).toEqual([1000, 400, 0]);
    expect(r.stats.netFlowUsd).toBe(-1000);
    expect(r.stats.twrPct).toBeCloseTo(0, 9);
    expect(r.stats.maxDrawdownPct).toBe(0);
  });

  test("a withdrawal pays the fee on what it sells", () => {
    const config: BranchConfig = {
      startDate: "2024-01-31",
      initialCapitalUsd: 1000,
      allocations: [{ coin: "BTC", weightPct: 50 }, { coin: "USDC", weightPct: 50 }],
      rebalance: "none",
      costs: { feeBps: 100 },
      cashflow: { amountUsd: -200, every: "monthly" },
    };
    // entry fee 5 -> 995 in; Feb 1 sells 200/995 of everything: BTC notional 497.5 x 0.201 = 100, fee 1.
    const r = simulate(config, { BTC: flat([jan31, feb01]) });
    expect(r.equity[1]!.value).toBeCloseTo(795, 9);
    expect(r.stats.netFlowUsd).toBeCloseTo(-199, 9);
    expect(r.stats.feesUsd).toBeCloseTo(6, 9);
  });
});

describe("stats helpers", () => {
  test("riskStats on a known series", () => {
    const s = riskStats([0.01, -0.01, 0.01, -0.01]);
    expect(s.sharpe).toBe(0);
    expect(s.volPct).toBeCloseTo(Math.sqrt(4 / 3) * 0.01 * Math.sqrt(365) * 100, 9);
    expect(riskStats([0.01]).volPct).toBe(0);
  });

  test("longest drawdown counts days until a new high, open at the end", () => {
    const pts = [100, 90, 95, 101, 99, 98].map((value, i) => ({ ts: i * DAY, value }));
    expect(longestDrawdownDays(pts)).toBe(2);
    const open = [100, 90, 80, 85, 86, 87].map((value, i) => ({ ts: i * DAY, value }));
    expect(longestDrawdownDays(open)).toBe(5);
  });

  test("monthly returns chain month-end to month-end", () => {
    const pts = [
      { ts: jan31, value: 100 },
      { ts: feb01, value: 110 },
      { ts: feb02, value: 121 },
      { ts: mar01, value: 60.5 },
    ];
    expect(monthlyReturns(pts)).toEqual([
      { month: "2024-01", returnPct: 0 },
      { month: "2024-02", returnPct: expect.closeTo(21, 9) },
      { month: "2024-03", returnPct: expect.closeTo(-50, 9) },
    ]);
  });
});

describe("rolling starts", () => {
  const t0 = Date.parse("2022-01-01");
  // 800 days of BTC compounding 0.1% a day.
  const btc = Array.from({ length: 800 }, (_, i) => ({ ts: t0 + i * DAY, c: 100 * 1.001 ** i }));
  const config: BranchConfig = { startDate: "2022-01-01", initialCapitalUsd: 1000, allocations: [{ coin: "BTC", weightPct: 100 }], rebalance: "none" };

  test("defaults to 365-day windows every 7 days when the history fits two of them", () => {
    const r = simulate(config, { BTC: btc });
    expect(r.rolling!.windowDays).toBe(365);
    expect(r.rolling!.stepDays).toBe(7);
    expect(r.rolling!.summary.n).toBe(Math.ceil((800 - 365) / 7));
    for (const p of r.rolling!.points) {
      expect(p.returnPct).toBeCloseTo((1.001 ** 365 - 1) * 100, 6);
      expect(p.vsBtcPct).toBeCloseTo(0, 6);
      expect(p.maxDrawdownPct).toBe(0);
    }
    expect(r.rolling!.summary.positivePct).toBe(100);
  });

  test("a USDC branch never beats a rising BTC in any window", () => {
    const r = simulate({ ...config, allocations: [{ coin: "USDC", weightPct: 100 }], rollingWindowDays: 90 }, { BTC: btc });
    expect(r.rolling!.windowDays).toBe(90);
    expect(r.rolling!.summary.beatBtcPct).toBe(0);
    expect(r.rolling!.summary.median).toBe(0);
  });

  test("rollingWindowDays 0 turns it off; too short a history skips it", () => {
    expect(simulate({ ...config, rollingWindowDays: 0 }, { BTC: btc }).rolling).toBeUndefined();
    expect(simulate(config, { BTC: btc.slice(0, 40) }).rolling).toBeUndefined();
  });
});
