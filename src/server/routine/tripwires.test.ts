import { describe, expect, test } from "bun:test";
import type { BoardRow, Positioning, TfRead } from "./board.js";
import { evaluateTripwires, formatTripwire, tripwireKey } from "./tripwires.js";

export function tf(over: Partial<TfRead> = {}): TfRead {
  return {
    bars: 100, close: 100, atr: 4, atrPct: 4, sma20: 98, sma50: 95, vsSma20Atr: 0.5, trend: "range",
    high: 110, low: 90, rangePos: 0.5, breakout: null, sweep: null, volRatio: 1, atrRatio: 1, ...over,
  };
}

export function pos(over: Partial<Positioning> = {}): Positioning {
  return {
    fundingAnnPct: 10.95, funding24hAnnPct: 10.95, funding7dAnnPct: 10.95, fundingPctile7d: 50, cexFundingAnnPct: 10.95, fundingVsCexAnnPct: 0,
    premiumBps: 0, oiUsd: 50_000_000, volUsd24h: 100_000_000, oiToVol: 0.5, oiChg4hPct: 0, oiChg24hPct: 0, oiChg7dPct: 0,
    ret4hPct: 0, ret24hPct: 0, ret7dPct: 0, flow24h: "quiet", ...over,
  };
}

/** A quiet market at 100 inside a 90–110 range: trips nothing. */
export function row(coin: string, over: { tf?: Partial<Record<"4h" | "1d" | "1w", Partial<TfRead>>>; pos?: Partial<Positioning>; levels?: BoardRow["levels"] } = {}): BoardRow {
  return {
    coin,
    mark: 100,
    tf: { "4h": tf(over.tf?.["4h"]), "1d": tf(over.tf?.["1d"]), "1w": tf(over.tf?.["1w"]) },
    pos: pos(over.pos),
    rs: { vsBtc24hPct: 0, vsBtc7dPct: 0 },
    xs: { fundingZ: 0, oiChg24hZ: 0, ret24hZ: 0 },
    levels: { mark: 100, "1d.pdh": 102, "1d.pdl": 97, "1d.high20": 110, "1d.low20": 90, "1d.sma20": 98, "4h.high20": 104, "4h.low20": 96, "1w.sma20": 92, ...over.levels },
  };
}

describe("tripwires", () => {
  test("a quiet market trips nothing", () => {
    expect(evaluateTripwires([row("BTC")])).toEqual({ hits: [], near: [] });
  });

  test("crowded longs pressed into the range high is a funding_fade hit, with every condition's value", () => {
    const { hits } = evaluateTripwires([row("HYPE", { pos: { fundingAnnPct: 41.2, oiChg24hPct: 6, ret24hPct: 1.5 }, tf: { "1d": { rangePos: 0.9 } } })]);
    expect(hits.map(tripwireKey)).toEqual(["HYPE|funding_fade|short"]);
    expect(hits[0]!.conditions.map((c) => [c.value, c.pass])).toEqual([
      [41.2, true],
      [6, true],
      [0.9, true],
      [0.38, true], // 1.5% over a 4% ATR
    ]);
    expect(formatTripwire(hits[0]!)).toContain("funding ann % 41.2 >= 30 ✓");
  });

  test("one numeric condition short is a near-miss, ranked by how close; a missing breakout is never near", () => {
    const { hits, near } = evaluateTripwires([
      row("SOL", { pos: { fundingAnnPct: 28, oiChg24hPct: 6 }, tf: { "1d": { rangePos: 0.9 } } }), // funding 28 vs 30
      row("ETH", { pos: { fundingAnnPct: 41, oiChg24hPct: 1 }, tf: { "1d": { rangePos: 0.9 } } }), // OI 1 vs 3
      row("ZEC", { pos: { oiChg24hPct: 5 }, tf: { "1d": { volRatio: 2 } } }), // range_breakout without a breakout
    ]);
    expect(hits).toEqual([]);
    expect(near.map((n) => [n.asset, n.setup_id, n.gap])).toEqual([
      ["SOL", "funding_fade", 0.07],
      ["ETH", "funding_fade", 0.67],
    ]);
  });

  test("a sweep of the range high with longs paying is a failed_breakout short; an aligned pullback is an htf_pullback", () => {
    const sweep = evaluateTripwires([row("XPL", { tf: { "4h": { sweep: "high" } }, pos: { fundingAnnPct: 15, oiChg24hPct: 2 } })]);
    expect(sweep.hits.map(tripwireKey)).toEqual(["XPL|failed_breakout|short"]);
    const trend = { trend: "up" as const };
    const pull = evaluateTripwires([row("BTC", { tf: { "1w": trend, "1d": { ...trend, vsSma20Atr: -0.3 } } })]);
    expect(pull.hits.map(tripwireKey)).toEqual(["BTC|htf_pullback|long"]);
  });

  test("a washout with OI flushed and funding reset is a post_liquidation_reclaim; shorts paying into an OI build is negative_funding_build", () => {
    const flush = evaluateTripwires([row("LIT", { pos: { ret24hPct: -9, oiChg24hPct: -15, fundingAnnPct: -5 } })]);
    expect(flush.hits.map(tripwireKey)).toEqual(["LIT|post_liquidation_reclaim|long"]);
    const squeeze = evaluateTripwires([row("ENA", { pos: { fundingAnnPct: -20, oiChg24hPct: 4, ret24hPct: -1 } })]);
    expect(squeeze.hits.map(tripwireKey)).toEqual(["ENA|negative_funding_build|long"]);
  });

  test("missing data fails a condition, it never passes one", () => {
    const { hits } = evaluateTripwires([row("NEW", { pos: { fundingAnnPct: 41, oiChg24hPct: null }, tf: { "1d": { rangePos: 0.9 } } })]);
    expect(hits).toEqual([]);
  });
});
