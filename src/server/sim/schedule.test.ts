// Scheduled moves and endDate: dated (or hindsight low/high) re-allocations stitched into one replay.
import { describe, expect, test } from "bun:test";
import { resolveSchedule, simulate, type DailyClose } from "./engine.js";
import type { BranchConfig } from "../../shared/types.js";

const DAY = 86400000;
const t0 = Date.parse("2025-01-01");
const d = (i: number) => new Date(t0 + i * DAY).toISOString().slice(0, 10);
// BTC: 100, 80, 50, 100, 150, 120
const BTC: DailyClose[] = [100, 80, 50, 100, 150, 120].map((c, i) => ({ ts: t0 + i * DAY, c, l: c, h: c }));

const base = (o: Partial<BranchConfig> = {}): BranchConfig => ({
  startDate: d(0),
  initialCapitalUsd: 1000,
  allocations: [{ coin: "USDC", weightPct: 100 }],
  rebalance: "none",
  ...o,
});
const values = (r: { equity: { value: number }[] }) => r.equity.map((p) => Math.round(p.value * 100) / 100);

describe("schedule", () => {
  test("cash, buy on a date, sell on a date", () => {
    const r = simulate(
      base({
        schedule: [
          { date: d(2), allocations: [{ coin: "BTC", weightPct: 100 }] },
          { date: d(4), allocations: [{ coin: "USDC", weightPct: 100 }] },
        ],
      }),
      { BTC },
    );
    // 1000 cash; 20 BTC at 50; 2000 at 100; 3000 at 150, sold; flat after.
    expect(values(r)).toEqual([1000, 1000, 1000, 2000, 3000, 3000]);
    expect(r.moves).toEqual([
      { step: 0, date: d(2), valueUsd: 1000 },
      { step: 1, date: d(4), valueUsd: 3000 },
    ]);
    expect(r.stats.twrPct).toBeCloseTo(200, 9);
    expect(r.stats.maxDrawdownPct).toBe(0);
    expect(r.rolling).toBeUndefined();
  });

  test("hindsight windows fill on the low and the high of the reference coin", () => {
    const schedule: BranchConfig["schedule"] = [
      { date: d(0), until: d(3), allocations: [{ coin: "BTC", weightPct: 100 }] },
      { date: d(3), until: d(5), at: "high", allocations: [{ coin: "USDC", weightPct: 100 }] },
    ];
    const grid = BTC.map((c) => c.ts);
    expect(resolveSchedule(schedule, { BTC }, grid)).toEqual([2, 4]);
    expect(values(simulate(base({ schedule }), { BTC }))).toEqual([1000, 1000, 1000, 2000, 3000, 3000]);
  });

  test("a levered leg between moves", () => {
    // 2x long from 50: at 100 margin 1000 + 1000 x 2 x 1 = 3000; at 150, 1000 + 2000 x 2 = 5000, then sold.
    const r = simulate(
      base({
        schedule: [
          { date: d(2), allocations: [{ coin: "BTC", weightPct: 100, leverage: 2 }] },
          { date: d(4), allocations: [{ coin: "USDC", weightPct: 100 }] },
        ],
      }),
      { BTC },
    );
    expect(values(r)).toEqual([1000, 1000, 1000, 3000, 5000, 5000]);
  });

  test("a move pays the fee on the change in notional only", () => {
    // In: turnover 1000, fee 10, 990 -> 19.8 BTC. At 150: 2970. Out: fee 29.7 -> 2940.3.
    const r = simulate(
      base({
        costs: { feeBps: 100 },
        schedule: [
          { date: d(2), allocations: [{ coin: "BTC", weightPct: 100 }] },
          { date: d(4), allocations: [{ coin: "USDC", weightPct: 100 }] },
        ],
      }),
      { BTC },
    );
    expect(values(r)).toEqual([1000, 1000, 990, 1980, 2940.3, 2940.3]);
    expect(r.stats.feesUsd).toBeCloseTo(39.7, 9);
    // Halving a position trades half of it: at 100, 1980 of BTC -> 990 target, fee 9.9.
    const half = simulate(
      base({
        costs: { feeBps: 100 },
        schedule: [
          { date: d(2), allocations: [{ coin: "BTC", weightPct: 100 }] },
          { date: d(3), allocations: [{ coin: "BTC", weightPct: 50 }, { coin: "USDC", weightPct: 50 }] },
        ],
      }),
      { BTC },
    );
    expect(half.equity[3]!.value).toBeCloseTo(1970.1, 9);
  });

  test("a move on the start day replaces the starting allocations and is reported", () => {
    const r = simulate(base({ schedule: [{ date: d(0), allocations: [{ coin: "BTC", weightPct: 100 }] }] }), { BTC });
    expect(values(r)).toEqual([1000, 800, 500, 1000, 1500, 1200]);
    expect(r.moves).toEqual([{ step: 0, date: d(0), valueUsd: 1000 }]);
  });

  test("a wiped-out leg stays at zero through later moves", () => {
    // 10x long from 100 at d0: the 80 close (-20%) liquidates it.
    const r = simulate(
      base({
        allocations: [{ coin: "BTC", weightPct: 100, leverage: 10 }],
        schedule: [{ date: d(3), allocations: [{ coin: "BTC", weightPct: 100 }] }],
      }),
      { BTC },
    );
    expect(values(r)).toEqual([1000, 0, 0, 0, 0, 0]);
    expect(r.stats.maxDrawdownPct).toBeCloseTo(100, 9);
    expect(r.equity.every((p) => Number.isFinite(p.value))).toBe(true);
  });

  test("endDate stops the replay; a move after it is not filled", () => {
    const r = simulate(
      base({
        endDate: d(3),
        allocations: [{ coin: "BTC", weightPct: 100 }],
        schedule: [{ date: d(4), allocations: [{ coin: "USDC", weightPct: 100 }] }],
      }),
      { BTC },
    );
    expect(values(r)).toEqual([1000, 800, 500, 1000]);
    expect(r.moves).toEqual([]);
  });

  test("no schedule simulates exactly as before", () => {
    const cfg = base({ allocations: [{ coin: "BTC", weightPct: 100 }] });
    expect(simulate({ ...cfg, schedule: [] }, { BTC }).equity).toEqual(simulate(cfg, { BTC }).equity);
  });
});
