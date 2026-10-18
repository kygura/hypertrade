import { describe, expect, test } from "bun:test";
import { orderToIntent } from "./intent.js";
import { parseInput, type OrderCommand } from "./parse.js";

const ctx = { markPx: 60000, equityUsd: 10000, defaultLeverage: 3, defaultRiskPct: 0.5 };
function order(text: string): OrderCommand {
  const c = parseInput(text);
  if (c.kind !== "order") throw new Error(`not an order: ${text} -> ${JSON.stringify(c)}`);
  return c;
}
function ok(text: string, c = ctx) {
  const r = orderToIntent(order(text), c);
  if (!r.ok) throw new Error(r.error);
  return r;
}
function bad(text: string, c = ctx) {
  const r = orderToIntent(order(text), c);
  if (r.ok) throw new Error("expected failure");
  return r.error;
}

describe("orderToIntent: sizing", () => {
  test("risk % with pct stop", () => {
    // 10000 * 0.5% / 2% = 2500
    const r = ok("/long BTC risk 0.5% stop 2%");
    expect(r.intent).toEqual({ asset: "BTC", side: "long", leverage: 3, size: { usd: 2500 }, entry: { type: "market" }, stop: { type: "pct", pct: 2 } });
    expect(r.notes[0]).toContain("$2500 notional");
  });
  test("risk % with price stop uses mark", () => {
    // stop 58800 = 2% below 60000 -> 2500
    expect(ok("/long BTC risk 0.5% stop 58800").intent.size).toEqual({ usd: 2500 });
  });
  test("risk % with price stop uses limit when given", () => {
    // entry 50000, stop 49000 = 2% -> 10000*1%/2% = 5000
    expect(ok("/long BTC risk 1% stop 49000 @50000").intent.size).toEqual({ usd: 5000 });
  });
  test("short side price stop", () => {
    expect(ok("/short BTC risk 0.5% stop 61200").intent.size).toEqual({ usd: 2500 });
  });
  test("size null defaults to defaultRiskPct and says so", () => {
    const r = ok("/long BTC stop 2%");
    expect(r.intent.size).toEqual({ usd: 2500 });
    expect(r.notes[0]).toContain("size defaulted to risk 0.5%");
  });
  test("usd and pctBook pass through", () => {
    expect(ok("/long BTC $750 stop 2%").intent.size).toEqual({ usd: 750 });
    expect(ok("/long BTC 5% book stop 2%").intent.size).toEqual({ pctBook: 5 });
  });
  test("usd/pctBook sizing works with atr/pdl/pdh stops", () => {
    expect(ok("/long BTC $500 stop 1.5atr").intent.stop).toEqual({ type: "atr_mult", mult: 1.5 });
    expect(ok("/long BTC 5% book stop pdl").intent.stop).toEqual({ type: "prev_day_low" });
    expect(ok("/short BTC 5% book stop pdh").intent.stop).toEqual({ type: "prev_day_high" });
  });
  test.each(["/long BTC risk 1% stop 2atr", "/long BTC stop pdl", "/short BTC stop pdh"])("risk sizing refuses %j", (t) => {
    expect(bad(t)).toBe("risk sizing needs a price or % stop; use $ or % book with atr/pdl/pdh");
  });
  test("risk sizing without equity", () => {
    expect(bad("/long BTC risk 1% stop 2%", { ...ctx, equityUsd: 0 })).toMatch(/equity/);
    expect(ok("/long BTC $500 stop 2%", { ...ctx, equityUsd: 0 }).intent.size).toEqual({ usd: 500 });
  });
});

describe("orderToIntent: entry, leverage, target", () => {
  test("leverage default and override", () => {
    expect(ok("/long BTC $500 stop 2%").intent.leverage).toBe(3);
    expect(ok("/long BTC $500 stop 2% 7x").intent.leverage).toBe(7);
  });
  test("limit entry", () => {
    expect(ok("/long BTC $500 stop 2% @59000").intent.entry).toEqual({ type: "limit", px: 59000 });
  });
  test("tp price", () => {
    expect(ok("/long BTC $500 stop 2% tp 65000").intent.target).toBe(65000);
    expect(ok("/short BTC $500 stop 2% tp 55000").intent.target).toBe(55000);
  });
  test("tp pct from entry, both sides", () => {
    expect(ok("/long BTC $500 stop 2% tp 5%").intent.target).toBe(63000);
    expect(ok("/short BTC $500 stop 2% tp 5%").intent.target).toBe(57000);
  });
  test("tp pct from limit px", () => {
    expect(ok("/long BTC $500 stop 2% tp 10% @50000").intent.target).toBe(55000);
  });
  test("tp R from stop distance", () => {
    // stop 2% = 1200 -> 2R = 2400
    expect(ok("/long BTC $500 stop 2% tp 2R").intent.target).toBe(62400);
    expect(ok("/short BTC $500 stop 61200 tp 1R").intent.target).toBe(58800);
  });
  test("tp R needs a price/pct stop", () => {
    expect(bad("/long BTC $500 stop 1atr tp 2R")).toMatch(/tp in R needs a price or % stop/);
  });
  test("no tp -> no target key", () => {
    expect("target" in ok("/long BTC $500 stop 2%").intent).toBe(false);
  });
  test("notes mention tp derivation", () => {
    expect(ok("/long BTC $500 stop 2% tp 2R").notes.join(" ")).toContain("tp 2R from mark 60000 = 62400");
  });
});

describe("orderToIntent: errors", () => {
  test("stop on wrong side", () => {
    expect(bad("/long BTC $500 stop 61000")).toMatch(/must be below entry 60000 for a long/);
    expect(bad("/short BTC $500 stop 59000")).toMatch(/must be above entry 60000 for a short/);
  });
  test("tp on wrong side", () => {
    expect(bad("/long BTC $500 stop 2% tp 59000")).toMatch(/must be above entry/);
    expect(bad("/short BTC $500 stop 2% tp 61000")).toMatch(/must be below entry/);
  });
  test("no mark", () => {
    expect(bad("/long BTC $500 stop 2%", { ...ctx, markPx: 0 })).toMatch(/no mark price for BTC/);
  });
  test("zod issue surfaced (leverage default out of range)", () => {
    expect(bad("/long BTC $500 stop 2%", { ...ctx, defaultLeverage: 100 })).toMatch(/^leverage: /);
  });
  test("zod issue surfaced (bad asset)", () => {
    const cmd = { ...order("/long BTC $500 stop 2%"), coin: "bad coin!" };
    const r = orderToIntent(cmd, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/^asset: /);
  });
});
