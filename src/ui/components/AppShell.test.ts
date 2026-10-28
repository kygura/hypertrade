import { describe, expect, test } from "bun:test";
import { NAV, isActive } from "./AppShell";

const activeCells = (p: string) => NAV.filter((n) => isActive(p, n.to)).map((n) => n.label);

describe("AppShell NAV", () => {
  test("six cells in order", () => {
    expect(NAV.map((n) => n.label)).toEqual(["COCKPIT", "MARKET", "RESEARCH", "ENGINE", "ANALYST", "DESK"]);
  });

  test("MARKET is active for its four tabs and their drills", () => {
    for (const p of ["/markets", "/markets/HYPE", "/sectors", "/state", "/cycles", "/cycles/eth"]) {
      expect(activeCells(p)).toEqual(["MARKET"]);
    }
  });

  test("RESEARCH is active for /lab/* and /branches/*", () => {
    for (const p of ["/lab", "/lab/search", "/lab/runs/abc", "/lab/rules/r1", "/branches", "/branches/b1"]) {
      expect(activeCells(p)).toEqual(["RESEARCH"]);
    }
  });

  test("other families stay on their own cell", () => {
    expect(activeCells("/")).toEqual(["COCKPIT"]);
    expect(activeCells("/terminal")).toEqual(["COCKPIT"]);
    expect(activeCells("/strategies/x")).toEqual(["ENGINE"]);
    expect(activeCells("/desk")).toEqual(["DESK"]);
    expect(activeCells("/overview")).toEqual([]);
    expect(activeCells("/labx")).toEqual([]);
  });
});
