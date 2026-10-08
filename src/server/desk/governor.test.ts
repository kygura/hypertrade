import { describe, expect, test } from "bun:test";
import { loadDeskConfig } from "./config.js";
import { evaluateExit, evaluateOpen, floorToDecimals, type GovernorContext } from "./governor.js";
import type { AccountState, TradeProposal } from "./types.js";

const limits = loadDeskConfig({}).limits;
const NOW = new Date("2026-10-05T12:00:00Z");

function account(over: Partial<AccountState> = {}): AccountState {
  return { venue: "paper", equityUsd: 10_000, dayPnlUsd: 0, positions: [], available: true, ...over };
}

function gctx(over: Partial<GovernorContext> = {}): GovernorContext {
  return { limits, account: account(), market: { coin: "ETH", markPx: 4000, szDecimals: 4, isDelisted: false }, killSwitch: false, now: NOW, ...over };
}

const long: TradeProposal = {
  coin: "ETH",
  side: "long",
  setup: "spot-led breakout retest",
  thesis: "Spot-led rally with OI flat and funding neutral; retest of the breakout level held.",
  horizon: "swing",
  confidence: "medium",
  stop: 3800,
  target: 4500,
  riskPct: 0.5,
  invalidation: "daily close back under 3850",
  evidence: [
    { source: "flow_diagnostics", point: "spot_led_rally, trap 18" },
    { source: "macro", point: "net liquidity rising 4w" },
  ],
};

describe("evaluateOpen", () => {
  test("sizes from risk and the stop at the live mark", () => {
    const v = evaluateOpen(long, gctx());
    expect(v.approved).toBe(true);
    // risk 0.5% of 10k = 50; stop 5% away → 1000 notional → 0.25 ETH
    expect(v.sizing).toMatchObject({ markPx: 4000, size: 0.25, notionalUsd: 1000, riskUsd: 50, stopDistPct: 5, rr: 2.5 });
    expect(v.sizing!.feeUsd).toBeCloseTo(0.9, 2);
  });

  test("clips risk above the per-trade limit with a warning", () => {
    const v = evaluateOpen({ ...long, riskPct: 2 }, gctx());
    expect(v.approved).toBe(true);
    expect(v.sizing!.riskUsd).toBe(50);
    expect(v.warnings.join()).toContain("clipped");
  });

  test("caps notional at the per-coin leverage limit", () => {
    // stop 0.6% away → 50/0.006 = 8333 notional, cap 1x equity = 10000 → not capped; tighten the cap
    const v = evaluateOpen({ ...long, stop: 3976, target: 4100 }, gctx({ limits: { ...limits, maxCoinLeverage: 0.5 } }));
    expect(v.sizing!.notionalUsd).toBeLessThanOrEqual(5000);
    expect(v.warnings.join()).toContain("capped");
  });

  test.each([
    ["stop on the wrong side", { stop: 4100 }, "wrong side"],
    ["target on the wrong side", { target: 3900 }, "wrong side"],
    ["reward:risk too low", { target: 4200 }, "reward:risk"],
    ["stop too tight", { stop: 3990, target: 4100 }, "under the"],
    ["stop too wide", { stop: 3000, target: 6000 }, "over the"],
    ["entry limit passed", { entryLimit: 3950 }, "entry limit"],
    ["confidence below floor", { confidence: "low" as const }, "confidence"],
  ])("blocks: %s", (_n, patch, reason) => {
    const v = evaluateOpen({ ...long, ...patch }, gctx());
    expect(v.approved).toBe(false);
    expect(v.reasons.join(" | ")).toContain(reason);
  });

  test("blocks under the kill switch, after the day-loss limit, and for unknown coins", () => {
    expect(evaluateOpen(long, gctx({ killSwitch: true })).reasons.join()).toContain("kill switch");
    expect(evaluateOpen(long, gctx({ account: account({ dayPnlUsd: -250 }) })).reasons.join()).toContain("day loss");
    expect(evaluateOpen(long, gctx({ market: null })).approved).toBe(false);
  });

  test("one position per coin, and the position count limit", () => {
    const pos = { coin: "ETH", side: "long" as const, size: 1, entryPx: 3900, markPx: 4000, stopPx: 3700, tpPx: null, unrealizedPnl: 100, notionalUsd: 4000 };
    expect(evaluateOpen(long, gctx({ account: account({ positions: [pos] }) })).reasons.join()).toContain("already long ETH");
    const many = ["A", "B", "C", "D"].map((coin) => ({ ...pos, coin, notionalUsd: 100 }));
    expect(evaluateOpen(long, gctx({ account: account({ positions: many }) })).reasons.join()).toContain("positions open");
  });

  test("the open-risk budget shrinks the new trade", () => {
    // existing stop risk 180 of a 200 budget (2% of 10k) → 20 left
    const pos = { coin: "SOL", side: "long" as const, size: 10, entryPx: 200, markPx: 200, stopPx: 182, tpPx: null, unrealizedPnl: 0, notionalUsd: 2000 };
    const v = evaluateOpen(long, gctx({ account: account({ positions: [pos] }) }));
    expect(v.approved).toBe(true);
    expect(v.sizing!.riskUsd).toBeLessThanOrEqual(20);
  });

  test("short side mirrors the checks", () => {
    const v = evaluateOpen({ ...long, side: "short", stop: 4200, target: 3500 }, gctx());
    expect(v.approved).toBe(true);
    expect(v.sizing!.rr).toBe(2.5);
  });
});

describe("evaluateExit", () => {
  const pos = { coin: "ETH", side: "long" as const, size: 0.3333, entryPx: 3900, markPx: 4000, stopPx: 3700, tpPx: null, unrealizedPnl: 33, notionalUsd: 1333 };
  test("partial exits floor to the size step", () => {
    const v = evaluateExit({ coin: "ETH", fraction: 0.5, reason: "take half" }, gctx({ account: account({ positions: [pos] }) }));
    expect(v.approved).toBe(true);
    expect(v.sizing!.size).toBe(0.1666);
  });
  test("no position, no exit", () => {
    expect(evaluateExit({ coin: "ETH", fraction: 1, reason: "close it" }, gctx()).reasons.join()).toContain("no open ETH");
  });
});

test("floorToDecimals never rounds up", () => {
  expect(floorToDecimals(0.123456, 4)).toBe(0.1234);
  expect(floorToDecimals(0.29999999999, 2)).toBe(0.3);
  expect(floorToDecimals(12.9, 0)).toBe(12);
});
