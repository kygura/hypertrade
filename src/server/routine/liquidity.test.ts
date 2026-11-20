import { describe, expect, test } from "bun:test";
import { bucketIndex, type LiqMapSnapshot } from "../../shared/platform.js";
import type { Candle } from "../../shared/types.js";
import { clearedLiquidity, equalLevels, liquidityLevels, roundLevels, snapshotBefore, sweepOf, type LiqLevel } from "./liquidity.js";

const H4 = 4 * 3_600_000;
const T0 = Date.UTC(2026, 10, 1);
const bar = (i: number, o: number, h: number, l: number, c: number, span = H4): Candle => ({ t: T0 + i * span, T: T0 + (i + 1) * span - 1, o, h, l, c, v: 1 });
const lvl = (px: number, side: LiqLevel["side"], source: LiqLevel["source"], key: string): LiqLevel => ({ px, side, source, touches: 1, key });

describe("liquidityLevels", () => {
  // Flat 4h bars at 100 with two swing highs at 105 and 105.05 (bars 5 and 15), never closed above.
  const c4h = Array.from({ length: 30 }, (_, i) => (i === 5 ? bar(i, 100, 105, 99, 100) : i === 15 ? bar(i, 100, 105.05, 99, 100) : bar(i, 100, 101, 99, 100)));
  const now = T0 + 30 * H4;

  test("equal highs: two fractal swing highs within tolerance, no close above since", () => {
    expect(equalLevels(c4h, "high", 0.4, now)).toEqual([{ px: 105.05, side: "high", source: "equal", touches: 2, key: "eq:high:105.05" }]);
    const closedAbove = c4h.map((c, i) => (i === 20 ? { ...c, h: 106, c: 105.5 } : c));
    expect(equalLevels(closedAbove, "high", 0.4, now)).toEqual([]);
  });

  test("a menu level within 0.1 ATR of an equal high merges into it, touches summed; lows below the mark stay", () => {
    const levels = liquidityLevels({ mark: 100, c4h, c1d: [], levels: { "4h.high20": 105.05, "1d.pdl": 97, "1d.sma20": 98 }, atr1d: 4, now });
    const high = levels.filter((l) => l.side === "high" && l.source !== "round");
    expect(high).toEqual([{ px: 105.05, side: "high", source: "equal", touches: 3, key: "eq:high:105.05" }]);
    expect(levels.find((l) => l.key === "1d.pdl")).toEqual({ px: 97, side: "low", source: "pdl", touches: 1, key: "1d.pdl" });
    expect(levels.some((l) => l.key === "1d.sma20")).toBe(false); // SMAs are not liquidity levels
  });

  test("a high below the mark is not a level to sweep from below", () => {
    expect(liquidityLevels({ mark: 100, c4h: [], c1d: [], levels: { "1d.pdh": 99 }, atr1d: 4, now }).some((l) => l.key === "1d.pdh")).toBe(false);
  });

  test("round numbers: the roundest step within 1 ATR, one per side, for BTC, SOL and a sub-$1 coin", () => {
    const px = (mark: number, atr: number) => roundLevels(mark, atr).map((l) => [l.side, l.px]);
    expect(px(90_123, 2_500)).toEqual([["high", 92_500], ["low", 90_000]]);
    expect(px(151.3, 6)).toEqual([["low", 150]]); // 160 is 8.7 away, beyond 1 ATR
    expect(px(0.4567, 0.03)).toEqual([["high", 0.475], ["low", 0.45]]);
    expect(roundLevels(100, null)).toEqual([]);
  });
});

describe("sweepOf", () => {
  const levels = [lvl(97, "low", "pdl", "1d.pdl"), lvl(98, "low", "range20", "4h.low20"), lvl(104, "high", "range20", "4h.high20")];

  test("the farthest level the wick reached: the pdl beyond the range low", () => {
    const s = sweepOf(bar(0, 100, 100.5, 96.5, 99), levels, 2, "4h")!;
    expect(s.level.key).toBe("1d.pdl");
    expect([s.side, s.depthAtr, s.reclaimed, s.wick, s.wickShare]).toEqual(["low", 0.25, true, 96.5, 0.13]);
  });

  test("a close beyond every level reached is a breakout: reclaimed false", () => {
    const s = sweepOf(bar(0, 100, 100.5, 96.5, 96.8), levels, 2)!;
    expect([s.level.key, s.reclaimed]).toEqual(["1d.pdl", false]);
  });

  test("a close back above the pdl but still below the range low: the reclaimed pdl", () => {
    const s = sweepOf(bar(0, 100, 100.5, 96.5, 97.5), levels, 2)!;
    expect([s.level.key, s.reclaimed]).toEqual(["1d.pdl", true]);
  });

  test("a wick through the range low only, closing below it but above nothing reclaimed: the range low, not reclaimed", () => {
    const s = sweepOf(bar(0, 100, 100.5, 97.5, 97.8), levels, 2)!;
    expect([s.level.key, s.reclaimed]).toEqual(["4h.low20", false]);
  });

  test("no level traded through, or no ATR: null", () => {
    expect(sweepOf(bar(0, 100, 101, 99, 100), levels, 2)).toBeNull();
    expect(sweepOf(bar(0, 100, 100.5, 96.5, 99), levels, null)).toBeNull();
  });
});

describe("clearedLiquidity", () => {
  const cell = (px: number, longUsd: number, shortUsd = 0) => ({ idx: bucketIndex(px, 25), longUsd, shortUsd });
  const snap = (ts: number, buckets: LiqMapSnapshot["buckets"]): LiqMapSnapshot => ({ coin: "BTC", ts: new Date(ts).toISOString(), mark: 100, bucketBps: 25, buckets });
  const t = T0 + 10 * H4;
  const pre = snap(t - 15 * 60_000, [cell(96.8, 4_000_000), cell(95, 1_000_000), cell(105, 0, 9_000_000)]);
  const post = snap(t + 5 * 60_000, [cell(95, 1_000_000)]); // the swept longs are gone after the bar

  test("reads the snapshot before the bar, not the one after it", () => {
    expect(snapshotBefore([post, pre], t)).toBe(pre);
    const sweep = { side: "low" as const, level: lvl(97, "low", "pdl", "1d.pdl") };
    const c = clearedLiquidity({ pre: snapshotBefore([post, pre], t), sweep, wickExtreme: 96.5, coverageRatio: 0.2 })!;
    expect(c.clearedUsd).toBe(4_000_000); // the 96.8 cell lies wholly inside [96.5, 97]
    expect(c.shareOfSide).toBe(0.8);
    expect(c.coverageRatio).toBe(0.2);
    expect(clearedLiquidity({ pre: snapshotBefore([post], t), sweep, wickExtreme: 96.5, coverageRatio: 0.2 })).toBeNull();
  });

  test("a high sweep sums shorts between the level and the wick high", () => {
    const c = clearedLiquidity({ pre, sweep: { side: "high", level: lvl(104.5, "high", "pwh", "1w.pwh") }, wickExtreme: 106, coverageRatio: null })!;
    expect(c.clearedUsd).toBe(9_000_000);
  });

  test("no snapshot: null (unknown), never 0", () => {
    expect(clearedLiquidity({ pre: null, sweep: { side: "low", level: lvl(97, "low", "pdl", "1d.pdl") }, wickExtreme: 96, coverageRatio: null })).toBeNull();
  });
});
