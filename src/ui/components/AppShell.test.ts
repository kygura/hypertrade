import { describe, expect, test } from "bun:test";
import { NAV, isActive } from "./AppShell";

const activeCells = (p: string) => NAV.filter((n) => isActive(p, n.to)).map((n) => n.label);

describe("AppShell NAV", () => {
  test("two cells in order", () => {
    expect(NAV.map((n) => [n.label, n.to])).toEqual([
      ["MARKET", "/"],
      ["RESEARCH", "/lab"],
    ]);
  });

  test("MARKET is active for the landing and every coin page", () => {
    for (const p of ["/", "/markets/HYPE", "/markets/kPEPE"]) {
      expect(activeCells(p)).toEqual(["MARKET"]);
    }
  });

  test("RESEARCH is active for /lab/*", () => {
    for (const p of ["/lab", "/lab/search", "/lab/runs/abc", "/lab/rules/r1"]) {
      expect(activeCells(p)).toEqual(["RESEARCH"]);
    }
  });

  test("parked pages light no cell", () => {
    for (const p of ["/feed", "/terminal", "/watch", "/desk", "/branches", "/sectors", "/cycles/eth", "/strategies/x", "/analyst", "/marketsx", "/labx"]) {
      expect(activeCells(p)).toEqual([]);
    }
  });
});
