import { describe, expect, test } from "bun:test";
import type { RadarCall } from "../../shared/radar";
import type { Rule } from "./lab";
import { boardStudy, STUDY_DEFAULTS } from "../../shared/research";
import { boardHref, boardKey, flatSignals, recentCalls, rootRedirect, signalBlocks, signalStudyHref, type BoardSignal } from "./research";

const rule: Rule = { asset: "BTC", direction: "long", horizonDays: 5, conditions: [{ feature: "ht:funding|z|30", op: "<", threshold: -1 }] };
const sig = (id: string, coin: string, at: number, over: Partial<BoardSignal> = {}): BoardSignal => ({
  id, source: "rule", coin, direction: null, tested: null, scope: "coin", headline: "", at, rule: null, ruleText: null, href: null, evidence: null, ...over,
});

describe("signalBlocks", () => {
  const list = [sig("a", "ETH", 1), sig("b", "BTC", 5), sig("c", "ETH", 9), sig("d", "SOL", 3)];
  test("newest first; a coin with several signals is grouped at its newest, rows newest first", () => {
    const blocks = signalBlocks(list);
    expect(blocks.map((b) => [b.coin, b.grouped, b.signals.map((s) => s.id)])).toEqual([
      ["ETH", true, ["c", "a"]],
      ["BTC", false, ["b"]],
      ["SOL", false, ["d"]],
    ]);
    expect(flatSignals(blocks).map((s) => s.id)).toEqual(["c", "a", "b", "d"]);
  });
  test("?coin= filters case-insensitively; blank is no filter; the input is not mutated", () => {
    expect(signalBlocks(list, "eth").flatMap((b) => b.signals.map((s) => s.id))).toEqual(["c", "a"]);
    expect(signalBlocks(list, " ")).toHaveLength(3);
    expect(signalBlocks(list, "DOGE")).toEqual([]);
    expect(list.map((s) => s.id)).toEqual(["a", "b", "c", "d"]);
  });
});

describe("rootRedirect: old `/` queries", () => {
  test("review=1 → the Terminal review; any Cockpit param → /feed with the query intact", () => {
    expect(rootRedirect("?review=1")).toBe("/terminal?review=1");
    expect(rootRedirect("?id=abc")).toBe("/feed?id=abc");
    expect(rootRedirect("?status=ready&tier=2")).toBe("/feed?status=ready&tier=2");
    expect(rootRedirect("?liq=ETH&liqh=6&coin=ETH")).toBe("/feed?liq=ETH&liqh=6&coin=ETH");
  });
  test("the board's own ?coin= and an empty query stay on the board", () => {
    expect(rootRedirect("")).toBeNull();
    expect(rootRedirect("?coin=ETH")).toBeNull();
    expect(rootRedirect("?review=0")).toBeNull();
  });
});

describe("links and scope", () => {
  test("study on the coin unless the scope is the universe; no rule, no link", () => {
    expect(boardStudy(sig("a", "ETH", 1, { rule }))).toEqual({ rule, coin: "ETH", ...STUDY_DEFAULTS });
    expect(boardStudy(sig("a", "ETH", 1, { rule, scope: "universe" }))).toEqual({ rule, ...STUDY_DEFAULTS });
    expect(signalStudyHref(sig("a", "ETH", 1, { rule }))).toBe(`/lab/study?rule=${encodeURIComponent(JSON.stringify(rule))}&coin=ETH`);
    expect(signalStudyHref(sig("a", "ETH", 1, { rule, scope: "universe" }))).toBe(`/lab/study?rule=${encodeURIComponent(JSON.stringify(rule))}`);
    expect(signalStudyHref(sig("a", "ETH", 1))).toBeNull();
    expect(boardHref("xyz:SKHX")).toBe("/?coin=xyz%3ASKHX");
  });
});

test("boardKey: j/k/Enter/s; nothing while typing, in a dialog or with a modifier", () => {
  expect(["j", "k", "Enter", "s", "x"].map((key) => boardKey({ key, dialogOpen: false }))).toEqual(["next", "prev", "open", "study", null]);
  expect(boardKey({ key: "j", target: "input", dialogOpen: false })).toBeNull();
  expect(boardKey({ key: "j", editable: true, dialogOpen: false })).toBeNull();
  expect(boardKey({ key: "j", dialogOpen: true })).toBeNull();
  expect(boardKey({ key: "s", metaKey: true, dialogOpen: false })).toBeNull();
});

test("recentCalls: newest first, capped", () => {
  const c = (id: string, date: string) => ({ id, date, at: `${date}T08:00:00Z` }) as RadarCall;
  expect(recentCalls([c("a", "2026-11-01"), c("b", "2026-11-08"), c("c", "2026-11-05")], 2).map((x) => x.id)).toEqual(["b", "c"]);
});
