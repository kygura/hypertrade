import { describe, expect, test } from "bun:test";
import { orderToIntent, type SizedOrder } from "./intent.js";
import { parseInput } from "./parse.js";

const ctx = { markPx: 60000, defaultLeverage: 3 };
function order(text: string): SizedOrder {
  const c = parseInput(text);
  if (c.kind !== "order" || !c.size || "riskPct" in c.size) throw new Error(`not a $ or % book order: ${text} -> ${JSON.stringify(c)}`);
  return { ...c, size: c.size };
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
  test("usd and pctBook pass through", () => {
    expect(ok("/long BTC $750 stop 2%").intent.size).toEqual({ usd: 750 });
    expect(ok("/long BTC 5% book stop 2%").intent.size).toEqual({ pctBook: 5 });
  });
  test("usd/pctBook sizing works with atr/pdl/pdh stops", () => {
    expect(ok("/long BTC $500 stop 1.5atr").intent.stop).toEqual({ type: "atr_mult", mult: 1.5 });
    expect(ok("/long BTC 5% book stop pdl").intent.stop).toEqual({ type: "prev_day_low" });
    expect(ok("/short BTC 5% book stop pdh").intent.stop).toEqual({ type: "prev_day_high" });
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
