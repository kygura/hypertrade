import { describe, expect, test } from "bun:test";
import type { LabDataset, Rule } from "../types.js";
import { carryReturns, equityCurve, excessReturns, FUNDING, perfStats, priceReturns, quickScore, sharpeOf, simulate, TAKER_FEE_BPS, turnCost, zoneActivity } from "./backtest.js";
import { makeCtx } from "./context.js";
import { HIGH, LOW, OPEN, replayCoin } from "./eventStudy.js";

const DAY = 86_400_000;
const T0 = Date.UTC(2024, 0, 1);
const price = [100, 110, 99, 99, 108.9];
const t = price.map((_, i) => T0 + i * DAY);
const pr = priceReturns(price);
const sig = [1, 1, 0, 1, 0];
/** Slippage that makes one unit of position change cost exactly 1 % with the taker fee on top. */
const ONE_PCT = 100 - TAKER_FEE_BPS;

describe("backtest", () => {
  test("long: next-day position, fee and slippage on every position change", () => {
    expect(turnCost(10)).toBeCloseTo((10 + TAKER_FEE_BPS) / 1e4, 15);
    const seg = simulate(pr, sig, 1, 5, ONE_PCT); // 1% per unit change
    // day1 +10% − entry 1%; day2 −10%; day3 flat, exit 1%; day4 +10% − entry 1%
    expect(Array.from(seg.ret).map((r) => +r.toFixed(10))).toEqual([0.09, -0.1, -0.01, 0.09]);
    expect(Array.from(seg.held)).toEqual([1, 1, 0, 1]);
    const s = perfStats(t, [seg]);
    expect(s.from).toBe("2024-01-02");
    expect(s.to).toBe("2024-01-05");
    expect(s.days).toBe(4);
    expect(s.totalReturn).toBeCloseTo(1.09 * 0.9 * 0.99 * 1.09 - 1, 12);
    expect(s.maxDrawdown).toBeCloseTo((1.09 * 0.9 * 0.99) / 1.09 - 1, 12);
    expect(s.trades).toBe(2); // second trade still open at the end
    expect(s.hitRate).toBe(0); // the closed one lost, exit cost included
    expect(s.exposure).toBe(0.75);
    expect(s.tradesPerYear).toBeCloseTo(2 / (4 / 365), 9);
    expect(s.cagr).toBeCloseTo((1 + s.totalReturn) ** (365 / 4) - 1, 6);
    const r = [0.09, -0.1, -0.01, 0.09];
    const m = r.reduce((a, b) => a + b) / 4;
    const sd = Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / 3);
    expect(s.sharpe).toBeCloseTo((m / sd) * Math.sqrt(365), 9);
    expect(quickScore(pr, Uint8Array.from(sig), 1, ONE_PCT, 1, 5, "sharpe")).toBeCloseTo(s.sharpe, 9);
    expect(quickScore(pr, Uint8Array.from(sig), 1, ONE_PCT, 1, 5, "return")).toBeCloseTo(s.totalReturn, 9);
  });

  test("short: inverted daily returns, same costs", () => {
    const seg = simulate(pr, sig.map((x) => -x), 1, 5, ONE_PCT);
    expect(Array.from(seg.ret).map((r) => +r.toFixed(10))).toEqual([-0.11, 0.1, -0.01, -0.11]);
    expect(quickScore(pr, Uint8Array.from(sig), -1, ONE_PCT, 1, 5, "return")).toBeCloseTo(perfStats(t, [seg]).totalReturn, 12);
  });

  test("hit rate counts closed winning episodes net of exit cost", () => {
    const s = perfStats(t, [simulate(pr, [1, 0, 0, 1, 1], 1, 5, ONE_PCT)]);
    // trade 1: +10% − 1% entry, then −1% exit on day 2 → 1.09·0.99 > 1; trade 2 open at end
    expect(s.trades).toBe(2);
    expect(s.hitRate).toBe(1);
    expect(perfStats(t, [simulate(pr, [0, 0, 0, 0, 0], 1, 5, ONE_PCT)]).hitRate).toBeNull();
  });

  test("a window without trades is flagged untested, not silently Sharpe 0", () => {
    const flat = perfStats(t, [simulate(pr, [0, 0, 0, 0, 0], 1, 5, ONE_PCT)]);
    expect(flat.trades).toBe(0);
    expect(flat.sharpe).toBe(0);
    expect(flat.untested).toBe(true);
    expect(perfStats(t, [simulate(pr, sig, 1, 5, ONE_PCT)]).untested).toBeUndefined();
  });

  test("zoneActivity: exposure and entries over return days, matching perfStats", () => {
    const z = zoneActivity(Uint8Array.from(sig), 1, 5);
    const s = perfStats(t, [simulate(pr, sig, 1, 5, ONE_PCT)]);
    expect(z).toEqual({ exposure: s.exposure, trades: s.trades });
    // a window starts flat: an open position at its start is an entry
    expect(zoneActivity(Uint8Array.from([1, 1, 0, 1, 1]), 2, 5)).toEqual({ exposure: 2 / 3, trades: 2 });
  });

  test("a window starts flat and segments concatenate", () => {
    const a = simulate(pr, [1, 1, 1, 1, 1], 1, 3, ONE_PCT);
    const b = simulate(pr, [1, 1, 1, 1, 1], 3, 5, ONE_PCT);
    expect(b.ret[0]).toBeCloseTo(0 - 0.01, 12); // re-entry cost at window start
    const s = perfStats(t, [a, b]);
    expect(s.days).toBe(4);
    expect(s.from).toBe("2024-01-02");
    expect(s.to).toBe("2024-01-05");
  });

  test("missing prices give a zero return, flat series a zero Sharpe", () => {
    expect(Array.from(priceReturns([100, NaN, 100, 0, 50]))).toEqual([0, 0, 0, 0, 0]);
    expect(sharpeOf([0, 0, 0])).toBe(0);
  });

  test("equity curve starts at 1 the day before the window", () => {
    const eq = equityCurve(t, simulate(pr, sig, 1, 5, 0), simulate(pr, [1, 1, 1, 1, 1], 1, 5, 0));
    expect(eq[0]).toEqual({ t: t[0]!, strategy: 1, benchmark: 1 });
    expect(eq[eq.length - 1]!.benchmark).toBeCloseTo((1.1 - turnCost(0)) * 0.9 * 1.1, 12); // the entry still pays the taker fee
  });
});

describe("funding on held exposure", () => {
  const flat = [100, 100, 100, 100, 100];
  const f = [NaN, 0.001, 0.002, NaN, 0.004];

  test("a held long falls by the funding paid, a short receives it, a day without a rate is charged none", () => {
    const { pr: carry, fundingDays } = carryReturns(flat, f);
    expect(fundingDays).toBe(3);
    const hold = [1, 1, 1, 1, 1];
    const long = simulate(carry, hold, 1, 5, 0);
    const gross = simulate(priceReturns(flat), hold, 1, 5, 0);
    // Same position, same fee: the whole difference is the funding of the held days.
    expect(Array.from(long.ret, (r, k) => +(gross.ret[k]! - r).toFixed(12))).toEqual([0.001, 0.002, 0, 0.004]);
    expect(perfStats(t, [gross]).totalReturn - perfStats(t, [long]).totalReturn).toBeCloseTo(0.007, 4);
    const short = simulate(carry, hold.map((x) => -x), 1, 5, 0);
    expect(Array.from(short.ret, (r, k) => +(r - gross.ret[k]!).toFixed(12))).toEqual([0.001, 0.002, 0, 0.004]);
    // Flat days pay nothing: funding is on held exposure only.
    expect(Array.from(simulate(carry, [0, 0, 0, 1, 0], 1, 5, 0).ret, (r) => +r.toFixed(12))).toEqual([0, 0, 0, -0.004 - turnCost(0)].map((x) => +x.toFixed(12)));
    expect(quickScore(carry, Uint8Array.from(hold), 1, 0, 1, 5, "return")).toBeCloseTo(perfStats(t, [long]).totalReturn, 12);
  });

  test("no funding series: returns are the price returns, fundingDays 0; the context reads ht:funding from the dataset", () => {
    expect(carryReturns(price)).toEqual({ pr, fundingDays: 0 });
    const data: LabDataset = { asset: "X", t, price: flat, metrics: { [FUNDING]: f } };
    const ctx = makeCtx(data);
    expect(ctx.fundingDays).toBe(3);
    expect(Array.from(ctx.pr, (x) => +x.toFixed(12))).toEqual([0, -0.001, -0.002, 0, -0.004]);
    expect(makeCtx({ ...data, metrics: {} }).fundingDays).toBe(0);
  });
});

describe("backtest and event study charge one trade the same", () => {
  // 30 days; the rule fires once (day 20), is held 3 days and exits at the horizon close: no stop or target in reach.
  const n = 30;
  const tt = Array.from({ length: n }, (_, i) => T0 + i * DAY);
  const close = tt.map((_, i) => 100 * (1 + 0.004 * Math.sin(i)));
  const funding = tt.map((_, i) => 0.0002 + 0.0001 * (i % 3));
  const fire = tt.map((_, i) => (i === 20 ? 1 : 0));
  const data: LabDataset = {
    asset: "X", t: tt, price: close,
    metrics: { [OPEN]: close, [HIGH]: close.map((c) => c * 1.002), [LOW]: close.map((c) => c * 0.998), [FUNDING]: funding, "x:fire": fire },
  };
  const H = 3;
  const SLIP = 7; // per side, the same number on both paths

  test.each(["long", "short"] as const)("%s: fee + slippage on entry and exit, funding on each held day", (direction) => {
    const rule: Rule = { asset: "X", direction, horizonDays: H, conditions: [{ feature: "x:fire|raw|0", op: ">=", threshold: 1 }] };
    const dir = direction === "long" ? 1 : -1;
    const [ev] = replayCoin(rule, data, { stopAtr: 50, targetAtr: 50, slippageBps: SLIP });
    expect(ev).toMatchObject({ date: new Date(tt[20]!).toISOString().slice(0, 10), exit: "horizon" });
    const entry = close[20]!;
    const held = [21, 22, 23];
    const fundingPaid = held.reduce((a, i) => a + dir * funding[i]!, 0);
    // Event study, back from R to a fraction of entry. fundingR = −funding / stop distance, so the stop distance is −fundingPaid / fundingR.
    const stopFrac = -fundingPaid / ev!.fundingR;
    const eventCost = (dir * (close[23]! - entry)) / entry - ev!.r * stopFrac;

    // Backtest: in from the close of day 20 over days 21..23, flat after (the exit charge lands on day 24).
    const ctx = makeCtx(data);
    const pos = tt.map((_, i) => (i >= 20 && i < 23 ? dir : 0));
    const seg = simulate(ctx.pr, pos, 1, n, SLIP);
    const gross = priceReturns(close);
    const backtestCost = Array.from(seg.ret).reduce((a, r, k) => a + (seg.held[k]! * gross[seg.a + k]! - r), 0);

    const expected = 2 * turnCost(SLIP) + fundingPaid;
    expect(backtestCost).toBeCloseTo(expected, 12);
    expect(eventCost).toBeCloseTo(expected, 12);
    expect(backtestCost).toBeCloseTo(eventCost, 12);
  });
});

describe("excessReturns: exposure-matched excess over the benchmark", () => {
  const b = simulate(pr, [1, 1, 1, 1, 1], 1, 5, 10);
  test("holding the asset has no excess; flat has none; a timed rule keeps what its days added", () => {
    expect(Array.from(excessReturns([b], [b]))).toEqual([0, 0, 0, 0]);
    expect(Array.from(excessReturns([simulate(pr, [0, 0, 0, 0, 0], 1, 5, 10)], [b]))).toEqual([0, 0, 0, 0]);
    const s = simulate(pr, sig, 1, 5, 10); // in the market 3 of 4 days
    expect(Array.from(excessReturns([s], [b]))).toEqual(Array.from(s.ret, (r, k) => r - 0.75 * b.ret[k]!));
    expect(perfStats(t, [s], [b]).excessSharpe).toBeCloseTo(sharpeOf(excessReturns([s], [b])), 12);
    expect(perfStats(t, [b], [b]).excessSharpe).toBe(0);
    expect(perfStats(t, [s]).excessSharpe).toBeUndefined();
  });
  test("exposure is matched per segment", () => {
    const [s1, s2] = [simulate(pr, [1, 1, 1, 1, 1], 1, 3, 10), simulate(pr, [0, 0, 0, 0, 0], 3, 5, 10)];
    const [b1, b2] = [simulate(pr, [1, 1, 1, 1, 1], 1, 3, 10), simulate(pr, [1, 1, 1, 1, 1], 3, 5, 10)];
    // Fully in over one block and out over the other is two beta positions, not timing: no excess in either.
    expect(Array.from(excessReturns([s1, s2], [b1, b2]))).toEqual([0, 0, 0, 0]);
  });
});
