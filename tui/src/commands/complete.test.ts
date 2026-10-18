import { describe, expect, test } from "bun:test";
import { complete } from "./complete.js";

const ctx = { coins: ["BTC", "ETH", "SOL", "HYPE", "kPEPE", "kPENDLE", "BTCD"], oids: [111, 112, 9] };

describe("complete", () => {
  test.each<[string, string, string[]]>([
    // command names
    ["/po", "/pos ", ["/pos"]],
    ["/pos", "/pos ", ["/pos"]],
    ["/pu", "/pulse ", ["/pulse"]],
    ["/c", "/c", ["/coin", "/close", "/cancel", "/clear"]],
    ["/cl", "/cl", ["/close", "/clear"]],
    ["/clo", "/close ", ["/close"]],
    ["/bu", "/buy ", ["/buy"]],
    ["/ma", "/markets ", ["/markets"]],
    ["/s", "/s", ["/short", "/stop", "/sell"]],
    ["/sh", "/short ", ["/short"]],
    ["/POS", "/pos ", ["/pos"]],
    ["/zzz", "/zzz", []],
    // coins
    ["/coin b", "/coin BTC", ["BTC", "BTCD"]],
    ["/coin bt", "/coin BTC", ["BTC", "BTCD"]],
    ["/coin e", "/coin ETH ", ["ETH"]],
    ["/book hy", "/book HYPE ", ["HYPE"]],
    ["/long so", "/long SOL ", ["SOL"]],
    ["/short kpe", "/short kpe", ["kPEPE", "kPENDLE"]],
    ["/close e", "/close ETH ", ["ETH"]],
    ["/stop s", "/stop SOL ", ["SOL"]],
    ["/b e", "/b ETH ", ["ETH"]],
    ["/buy e", "/buy ETH ", ["ETH"]],
    ["/coin ", "/coin ", ["BTC", "ETH", "SOL", "HYPE", "kPEPE", "kPENDLE", "BTCD"]],
    ["/coin q", "/coin q", []],
    // later tokens of coin commands are not completed
    ["/long BTC s", "/long BTC s", []],
    ["/close BTC 5", "/close BTC 5", []],
    // markets
    ["/markets o", "/markets oi ", ["oi"]],
    ["/markets f", "/markets funding ", ["funding"]],
    ["/markets c", "/markets chg ", ["chg"]],
    ["/markets ", "/markets ", ["oi", "vol", "chg", "funding"]],
    ["/m v", "/m vol ", ["vol"]],
    ["/markets oi v", "/markets oi v", []],
    ["/markets btc o", "/markets btc oi ", ["oi"]],
    // cancel
    ["/cancel a", "/cancel all ", ["all"]],
    ["/cancel 11", "/cancel 11", ["111", "112"]],
    ["/cancel 111", "/cancel 111 ", ["111"]],
    ["/cancel ", "/cancel ", ["all", "111", "112", "9"]],
    ["/cancel all e", "/cancel all ETH ", ["ETH"]],
    ["/cancel 9 b", "/cancel 9 BTC", ["BTC", "BTCD"]],
    ["/cancel all ETH x", "/cancel all ETH x", []],
    // not completable
    ["", "", []],
    ["hello", "hello", []],
    ["/pos x", "/pos x", []],
  ])("%j", (input, completed, options) => {
    expect(complete(input, ctx)).toEqual({ completed, options });
  });

  test("exact match among several does not advance", () => {
    expect(complete("/coin BTC", ctx)).toEqual({ completed: "/coin BTC", options: ["BTC", "BTCD"] });
  });
  test("missing oids", () => {
    expect(complete("/cancel ", { coins: [] })).toEqual({ completed: "/cancel all ", options: ["all"] });
  });
  test("coin order is preserved (caller sorts by OI)", () => {
    expect(complete("/coin ", { coins: ["Z", "A"] }).options).toEqual(["Z", "A"]);
  });
});
