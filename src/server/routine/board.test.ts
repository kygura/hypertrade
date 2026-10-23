import { describe, expect, test } from "bun:test";
import type { AssetCtx, Candle } from "../../shared/types.js";
import { appendSnapshot, boardUniverse, buildBoard, flowQuadrant, positioning, tfRead, weeklyFromDaily, type BoardHistory, type BoardInput } from "./board.js";

const H = 3_600_000;
const DAY = 24 * H;
const NOW = Date.parse("2026-10-23T12:00:00Z"); // a Friday
const T0 = Date.parse("2026-01-01T00:00:00Z");

/** Daily candles ending at the last full day before NOW; high/low ±1% around the close. */
function daily(closes: number[], vol = (_: number) => 100): Candle[] {
  const end = Date.UTC(2026, 9, 23); // today 00:00: today's bar is still forming, so it is left out
  return closes.map((c, i) => {
    const t = end - (closes.length - i) * DAY;
    return { t, T: t + DAY - 1, o: c, h: c * 1.01, l: c * 0.99, c, v: vol(i) };
  });
}
const ramp = (n: number, from: number, step: number) => Array.from({ length: n }, (_, i) => from + i * step);
const ctx = (name: string, over: Partial<AssetCtx> = {}): AssetCtx =>
  ({ name, markPx: 100, openInterest: 1000, funding: 0.0000125, premium: 0.0002, dayNtlVlm: 50_000, dayChange: 0.01, isDelisted: false, ...over }) as AssetCtx;

describe("timeframe read", () => {
  test("a breakout bar on rising volume in an uptrend; menu-level fields from completed bars only", () => {
    const closes = [...ramp(59, 100, 0.5), 140]; // last bar closes far above the prior 20-bar high
    const bars = daily(closes, (i) => (i === 59 ? 300 : 100));
    const forming: Candle = { t: Date.UTC(2026, 9, 23), T: Date.UTC(2026, 9, 24) - 1, o: 140, h: 200, l: 1, c: 150, v: 1 };
    const r = tfRead([...bars, forming], 20, 141, NOW)!;
    expect(r.bars).toBe(60);
    expect(r.close).toBe(140); // the forming bar is not a close
    expect(r.breakout).toBe("up");
    expect(r.sweep).toBeNull();
    expect(r.high).toBe(sigOf(129 * 1.01)); // prior 20 bars: closes 119.5…129, high +1%
    expect(r.trend).toBe("up");
    expect(r.volRatio).toBe(3);
    expect(r.rangePos).toBeGreaterThan(0.9);
    expect(tfRead(bars.slice(0, 20), 20, 141, NOW)).toBeNull(); // fewer than window + 2 bars
  });

  test("a sweep: traded above the prior high, closed back inside", () => {
    const bars = daily(ramp(30, 100, 0)); // flat at 100: prior high 101
    bars[29] = { ...bars[29]!, h: 105, c: 100.5 };
    const r = tfRead(bars, 20, 100.5, NOW)!;
    expect(r.sweep).toBe("high");
    expect(r.breakout).toBeNull();
    expect(r.trend).toBe("range");
  });

  test("weeks start on Monday 00:00 UTC; the current week is forming", () => {
    const bars = daily(ramp(10, 100, 1)); // Tue Oct 13 … Thu Oct 22
    const weeks = weeklyFromDaily(bars);
    expect(weeks.map((w) => new Date(w.t).toISOString().slice(0, 10))).toEqual(["2026-10-12", "2026-10-19"]);
    expect(weeks[0]).toMatchObject({ o: 100, c: 105, h: 105 * 1.01, l: 99, v: 600 });
    expect(weeks[1]!.T).toBeGreaterThan(NOW);
  });
});

describe("positioning", () => {
  test("OI change in contracts from the history, funding vs its own week and vs other venues, flow quadrant", () => {
    const history: BoardHistory = {
      updated_at: "",
      snapshots: [
        { t: new Date(NOW - 7 * DAY).toISOString(), rows: { SOL: [90, 800, 0] } },
        { t: new Date(NOW - DAY - H).toISOString(), rows: { SOL: [95, 900, 0] } },
        { t: new Date(NOW - 4 * H).toISOString(), rows: { SOL: [99, 990, 0] } },
      ],
    };
    const c4h: Candle[] = ramp(60, 90, 0.2).map((c, i) => {
      const t = NOW - (60 - i) * 4 * H;
      return { t, T: t + 4 * H - 1, o: c, h: c, l: c, c, v: 1 };
    });
    const funding = Array.from({ length: 168 }, (_, i) => ({ t: NOW - (168 - i) * H, rate: i < 144 ? 0.0000125 : 0.00005, premium: 0 }));
    const input: BoardInput = { ctx: ctx("SOL", { markPx: 102, openInterest: 1000, funding: 0.00005 }), c4h, c1d: null, funding, cexHourly: [0.0000125, 0.0000125] };
    const p = positioning(input, history, NOW);
    expect(p.oiChg4hPct).toBe(1.01);
    expect(p.oiChg24hPct).toBe(11.11); // 900 → 1000, the snapshot 25 h back is within tolerance
    expect(p.oiChg7dPct).toBe(25);
    expect(p.fundingAnnPct).toBe(43.8);
    expect(p.funding24hAnnPct).toBe(43.8);
    expect(p.fundingPctile7d).toBe(100);
    expect(p.cexFundingAnnPct).toBe(10.95);
    expect(p.fundingVsCexAnnPct).toBe(32.85);
    expect(p.premiumBps).toBe(2);
    expect(p.ret24hPct).toBeGreaterThan(0);
    expect(p.flow24h).toBe("new_longs");
    expect(positioning({ ...input, c4h: null }, null, NOW)).toMatchObject({ oiChg24hPct: null, flow24h: null, ret24hPct: 1 });
  });

  test("flow quadrant thresholds: |price| ≥ 1%, |OI| ≥ 2%", () => {
    expect(flowQuadrant(-3, 5)).toBe("new_shorts");
    expect(flowQuadrant(2, -4)).toBe("short_covering");
    expect(flowQuadrant(-2, -4)).toBe("long_liquidation");
    expect(flowQuadrant(0.5, 6)).toBe("oi_build_flat");
    expect(flowQuadrant(3, 1)).toBe("price_only");
    expect(flowQuadrant(0.2, 0.5)).toBe("quiet");
    expect(flowQuadrant(1, null)).toBeNull();
  });
});

describe("board", () => {
  test("cross-sectional z flags the outlier; relative strength is measured against BTC; the menu carries completed-bar levels", () => {
    const bars = daily(ramp(300, 100, 0.1));
    const coins = ["BTC", "ETH", "SOL", "HYPE", "ZEC", "XPL"];
    const inputs: BoardInput[] = coins.map((name) => ({
      ctx: ctx(name, { funding: name === "ZEC" ? 0.0001 : 0.0000125, dayChange: name === "SOL" ? 0.05 : 0.01 }),
      c4h: null,
      c1d: bars,
      funding: null,
      cexHourly: [],
    }));
    const board = buildBoard(inputs, null, new Date(NOW));
    const zec = board.rows.find((r) => r.coin === "ZEC")!;
    expect(zec.xs.fundingZ).toBeGreaterThan(50);
    expect(board.rows.find((r) => r.coin === "ETH")!.xs.fundingZ).toBe(0);
    expect(board.rows.find((r) => r.coin === "SOL")!.rs.vsBtc24hPct).toBe(4);
    expect(board.rows.find((r) => r.coin === "BTC")!.rs.vsBtc24hPct).toBeNull();
    const lv = zec.levels;
    expect(lv.mark).toBe(100);
    expect(lv["1d.pdh"]).toBe(sigOf(129.9 * 1.01));
    expect(lv["1d.sma200"]).toBeDefined();
    expect(lv["1w.pwh"]).toBeDefined();
    expect(lv["4h.high20"]).toBeUndefined(); // no 4h candles: no 4h levels
    expect(board.history).toEqual({ snapshots: 0, oldest: null });
  });

  test("universe: top by volume above the OI floor, plus the always-on list wherever listed", () => {
    const ctxs = [ctx("A", { dayNtlVlm: 9e9, openInterest: 1e6 }), ctx("B", { dayNtlVlm: 8e9, openInterest: 10 }), ctx("C", { dayNtlVlm: 1, openInterest: 1e6 }), ctx("BTC", { dayNtlVlm: 2, openInterest: 1 })];
    expect(boardUniverse(ctxs, ["BTC", "NOPE"], { top: 1, minOiUsd: 1e6 }).map((c) => c.name)).toEqual(["A", "BTC"]);
    expect(boardUniverse(ctxs, [], { top: 5, minOiUsd: 1e6 }).map((c) => c.name)).toEqual(["A", "C"]);
  });

  test("history: one snapshot per run, a re-run within 30 min replaces it, older than 8 days drops", () => {
    let h = appendSnapshot(null, [ctx("BTC")], new Date(NOW - 9 * DAY));
    h = appendSnapshot(h, [ctx("BTC")], new Date(NOW - 4 * H));
    h = appendSnapshot(h, [ctx("BTC", { openInterest: 1 })], new Date(NOW - 10 * 60_000));
    h = appendSnapshot(h, [ctx("BTC", { openInterest: 2 })], new Date(NOW));
    expect(h.snapshots.map((s) => s.t)).toEqual([new Date(NOW - 4 * H).toISOString(), new Date(NOW).toISOString()]);
    expect(h.snapshots.at(-1)!.rows.BTC).toEqual([100, 2, 0.0000125]);
  });
});

function sigOf(x: number) {
  return Number(x.toPrecision(5));
}
