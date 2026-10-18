import { describe, expect, test } from "bun:test";
import { parseInput, normalizeCoin, type Command } from "./parse.js";

function expectErr(input: string, token: string | undefined, msg?: RegExp) {
  const c = parseInput(input);
  expect(c.kind).toBe("error");
  if (c.kind !== "error") return;
  expect(c.token).toBe(token);
  if (msg) expect(c.message).toMatch(msg);
}

describe("parseInput: non-slash", () => {
  test.each<[string, Command]>([
    ["", { kind: "noop" }],
    ["   ", { kind: "noop" }],
    ["what is BTC doing?", { kind: "agent", text: "what is BTC doing?" }],
    ["  hello ", { kind: "agent", text: "hello" }],
    ["long BTC", { kind: "agent", text: "long BTC" }],
  ])("%j", (input, want) => expect(parseInput(input)).toEqual(want));
});

describe("parseInput: simple commands and aliases", () => {
  test.each<[string, Command]>([
    ["/pos", { kind: "pos" }],
    ["/p", { kind: "pos" }],
    ["  /POS ", { kind: "pos" }],
    ["/alerts", { kind: "alerts" }],
    ["/pulse", { kind: "pulse" }],
    ["/brief", { kind: "brief" }],
    ["/model", { kind: "model" }],
    ["/clear", { kind: "clear" }],
    ["/help", { kind: "help" }],
    ["/h", { kind: "help" }],
    ["/quit", { kind: "quit" }],
    ["/q", { kind: "quit" }],
    ["/markets", { kind: "markets" }],
    ["/m", { kind: "markets" }],
    ["/markets oi", { kind: "markets", sort: "oi" }],
    ["/markets funding", { kind: "markets", sort: "funding" }],
    ["/markets btc", { kind: "markets", filter: "btc" }],
    ["/markets vol sol", { kind: "markets", sort: "vol", filter: "sol" }],
    ["/markets sol CHG", { kind: "markets", sort: "chg", filter: "sol" }],
    ["/coin btc", { kind: "coin", coin: "BTC" }],
    ["/book eth", { kind: "book", coin: "ETH" }],
    ["/b ETH", { kind: "book", coin: "ETH" }],
    ["/coin kPEPE", { kind: "coin", coin: "kPEPE" }],
    ["/coin kpepe", { kind: "coin", coin: "KPEPE" }],
    ["/coin xyz:tsla", { kind: "coin", coin: "xyz:TSLA" }],
  ])("%j", (input, want) => expect(parseInput(input)).toEqual(want));

  test("normalizeCoin", () => {
    expect(normalizeCoin("kBONK")).toBe("kBONK");
    expect(normalizeCoin("hype")).toBe("HYPE");
    expect(normalizeCoin("1inch")).toBeNull();
    expect(normalizeCoin("stop")).toBeNull();
  });
});

describe("parseInput: errors on simple commands", () => {
  test("unknown command", () => expectErr("/foo", "/foo", /unknown command "\/foo"/));
  test("bare slash", () => expectErr("/", "/"));
  test("args on no-arg command", () => expectErr("/pos BTC", "BTC", /unexpected "BTC"/));
  test("coin missing", () => expectErr("/coin", undefined, /usage/));
  test("book missing", () => expectErr("/book", undefined, /usage/));
  test("bad coin", () => expectErr("/coin $$", "$$"));
  test("extra after coin", () => expectErr("/coin BTC ETH", "ETH"));
  test("two sorts", () => expectErr("/markets oi vol", "vol", /twice/));
  test("two filters", () => expectErr("/markets a b", "b"));
});

describe("parseInput: orders", () => {
  const base = { kind: "order", size: null, tp: null, leverage: null, limitPx: null } as const;

  test.each<[string, Command]>([
    ["/long BTC stop 2%", { ...base, side: "long", coin: "BTC", stop: { type: "pct", pct: 2 } }],
    ["/short eth stop 3500", { ...base, side: "short", coin: "ETH", stop: { type: "price", px: 3500 } }],
    ["/buy btc stop 2%", { ...base, side: "long", coin: "BTC", stop: { type: "pct", pct: 2 } }],
    ["/sell btc stop 2%", { ...base, side: "short", coin: "BTC", stop: { type: "pct", pct: 2 } }],
    ["/long BTC risk 0.5% stop 2% tp 3%", { ...base, side: "long", coin: "BTC", size: { riskPct: 0.5 }, stop: { type: "pct", pct: 2 }, tp: { pct: 3 } }],
    ["/long BTC $500 stop 1.5atr", { ...base, side: "long", coin: "BTC", size: { usd: 500 }, stop: { type: "atr_mult", mult: 1.5 } }],
    ["/long BTC 5% book stop pdl", { ...base, side: "long", coin: "BTC", size: { pctBook: 5 }, stop: { type: "prev_day_low" } }],
    ["/short BTC 5%book stop PDH", { ...base, side: "short", coin: "BTC", size: { pctBook: 5 }, stop: { type: "prev_day_high" } }],
    ["/long BTC stop 60k tp 2R", { ...base, side: "long", coin: "BTC", stop: { type: "price", px: 60000 }, tp: { r: 2 } }],
    ["/long BTC stop 60,000 tp 70,000", { ...base, side: "long", coin: "BTC", stop: { type: "price", px: 60000 }, tp: { px: 70000 } }],
    ["/long BTC $1,000 stop 2% 5x @61500", { ...base, side: "long", coin: "BTC", size: { usd: 1000 }, stop: { type: "pct", pct: 2 }, leverage: 5, limitPx: 61500 }],
    ["/long BTC $1.2m stop 2% @1.2k", { ...base, side: "long", coin: "BTC", size: { usd: 1_200_000 }, stop: { type: "pct", pct: 2 }, limitPx: 1200 }],
    ["/long kPEPE stop 2%", { ...base, side: "long", coin: "kPEPE", stop: { type: "pct", pct: 2 } }],
    // any order after COIN
    ["/long BTC 3x @60000 tp 1R stop 1% risk 1%", { ...base, side: "long", coin: "BTC", size: { riskPct: 1 }, stop: { type: "pct", pct: 1 }, tp: { r: 1 }, leverage: 3, limitPx: 60000 }],
    ["/long BTC 2.5x stop 2%", { ...base, side: "long", coin: "BTC", stop: { type: "pct", pct: 2 }, leverage: 2.5 }],
    ["/long BTC STOP 2% RISK 1%", { ...base, side: "long", coin: "BTC", size: { riskPct: 1 }, stop: { type: "pct", pct: 2 } }],
  ])("%j", (input, want) => expect(parseInput(input)).toEqual(want));

  test.each<[string, string | undefined, RegExp]>([
    ["/long BTC risk 0.5%", "stop", /stop is required/],
    ["/long BTC", "stop", /stop is required/],
    ["/long", undefined, /usage/],
    ["/long risk 1% stop 2%", "risk", /expected a coin/],
    ["/long 3x stop 2%", "3x", /expected a coin/],
    ["/long BTC stop", "stop", /stop needs a value/],
    ["/long BTC stop abc", "abc", /bad stop value "abc"/],
    ["/long BTC stop 0%", "0%", /stop percent/],
    ["/long BTC stop 80%", "80%", /stop percent/],
    ["/long BTC stop 11atr", "11atr", /ATR multiple/],
    ["/long BTC stop 2% stop 3%", "stop", /twice/],
    ["/long BTC risk 1 stop 2%", "1", /risk needs a percent/],
    ["/long BTC risk stop 2%", "stop", /risk needs a percent/],
    ["/long BTC risk 0% stop 2%", "0%", /risk needs/],
    ["/long BTC risk 1% $500 stop 2%", "$500", /size given twice/],
    ["/long BTC $500 5% book stop 2%", "5%", /twice/],
    ["/long BTC $abc stop 2%", "$abc", /bad size/],
    ["/long BTC 150% book stop 2%", "150%", /% book/],
    ["/long BTC 5% stop 2%", "5%", /ambiguous/],
    ["/long BTC 0x stop 2%", "0x", /leverage/],
    ["/long BTC 60x stop 2%", "60x", /leverage/],
    ["/long BTC 3x 4x stop 2%", "4x", /twice/],
    ["/long BTC @ stop 2%", "@", /bad limit/],
    ["/long BTC @abc stop 2%", "@abc", /bad limit/],
    ["/long BTC @1 @2 stop 2%", "@2", /twice/],
    ["/long BTC stop 2% tp", "tp", /tp needs a value/],
    ["/long BTC stop 2% tp xx", "xx", /bad tp value/],
    ["/long BTC stop 2% tp 0R", "0R", /bad tp value/],
    ["/long BTC stop 2% tp 1R tp 2R", "tp", /twice/],
    ["/long BTC stop 2% 500", "500", /unknown token "500"/],
    ["/long BTC stop 2% banana", "banana", /unknown token "banana"/],
  ])("error %j", (input, token, msg) => expectErr(input, token, msg));
});

describe("parseInput: close / cancel / stop", () => {
  test.each<[string, Command]>([
    ["/close btc", { kind: "close", coin: "BTC", pct: 100 }],
    ["/close BTC 50", { kind: "close", coin: "BTC", pct: 50 }],
    ["/close BTC 25%", { kind: "close", coin: "BTC", pct: 25 }],
    ["/close BTC 100", { kind: "close", coin: "BTC", pct: 100 }],
    ["/cancel all", { kind: "cancel", target: "all" }],
    ["/cancel ALL eth", { kind: "cancel", target: "all", coin: "ETH" }],
    ["/cancel 12345", { kind: "cancel", target: 12345 }],
    ["/cancel 12345 btc", { kind: "cancel", target: 12345, coin: "BTC" }],
    ["/stop btc 60000", { kind: "stop", coin: "BTC", px: 60000 }],
    ["/stop ETH 3.5k", { kind: "stop", coin: "ETH", px: 3500 }],
  ])("%j", (input, want) => expect(parseInput(input)).toEqual(want));

  test.each<[string, string | undefined, RegExp]>([
    ["/close", undefined, /usage/],
    ["/close BTC 0", "0", /close percent/],
    ["/close BTC 101", "101", /close percent/],
    ["/close BTC -5", "-5", /close percent/],
    ["/close BTC abc", "abc", /close percent/],
    ["/close BTC 50 x", "x", /unexpected/],
    ["/cancel", undefined, /usage/],
    ["/cancel abc", "abc", /not an order id/],
    ["/cancel 0", "0", /not an order id/],
    ["/cancel 1.5", "1.5", /not an order id/],
    ["/cancel -3", "-3", /not an order id/],
    ["/cancel 12 $$", "$$", /not a coin/],
    ["/cancel all BTC x", "x", /unexpected/],
    ["/stop", undefined, /usage/],
    ["/stop BTC", undefined, /usage/],
    ["/stop BTC abc", "abc", /bad stop price/],
    ["/stop BTC 0", "0", /bad stop price/],
    ["/stop BTC 1 2", "2", /unexpected/],
  ])("error %j", (input, token, msg) => expectErr(input, token, msg));
});
