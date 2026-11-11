import { describe, expect, test } from "bun:test";
import { NAV, freshnessOf, isActive } from "./AppShell";
import { MARKET_TABS } from "./market/MarketTabs";

const activeCells = (p: string) => NAV.filter((n) => isActive(p, n.to)).map((n) => n.label);

describe("AppShell NAV", () => {
  test("three cells in order, short labels fit the mobile bar", () => {
    expect(NAV.map((n) => n.label)).toEqual(["MOVES", "RESEARCH", "TRADE"]);
    expect(NAV.map((n) => n.to)).toEqual(["/moves", "/board", "/desk"]);
    for (const n of NAV) expect(n.tab.length).toBeLessThanOrEqual(5);
  });

  test("MOVES is the landing cell: active for its tabs, the hidden market pages and their drills", () => {
    for (const p of ["/moves", "/markets", "/markets/HYPE", "/sectors", "/state", "/cycles", "/cycles/eth"]) {
      expect(activeCells(p)).toEqual(["MOVES"]);
    }
  });

  test("RESEARCH is active for the board /board, /lab/* and /branches/*", () => {
    for (const p of ["/board", "/lab", "/lab/search", "/lab/runs/abc", "/lab/rules/r1", "/lab/catalogue", "/branches", "/branches/b1"]) {
      expect(activeCells(p)).toEqual(["RESEARCH"]);
    }
  });

  test("TRADE is active for its tabs and the hidden trade pages; ASK and ENGINE are no cell", () => {
    for (const p of ["/desk", "/order", "/journal", "/feed", "/terminal", "/watch", "/theses", "/query", "/asset/HYPE"]) {
      expect(activeCells(p)).toEqual(["TRADE"]);
    }
    for (const p of ["/", "/analyst", "/strategies/x", "/decisions", "/governor", "/overview", "/labx"]) expect(activeCells(p)).toEqual([]);
  });
});

describe("MarketTabs", () => {
  test("MOVES then MARKETS on the row; SECTORS, STATE and CYCLES are hidden", () => {
    expect(MARKET_TABS.filter((t) => !t.hidden).map((t) => t.label)).toEqual(["MOVES", "MARKETS"]);
    expect(MARKET_TABS.filter((t) => t.hidden).map((t) => t.label)).toEqual(["SECTORS", "STATE", "CYCLES"]);
    expect(MARKET_TABS[0]!.to).toBe("/moves");
  });
});

describe("freshnessOf", () => {
  test("a real failure is red", () => {
    expect(freshnessOf("upstream 502", null).status).toBe("down");
  });
  test("the no-database 503 is a neutral dot with the reason as its title", () => {
    const f = freshnessOf("DATABASE_URL is not set", null);
    expect(f.status).toBe("unknown");
    expect(f.title).toBe("DATABASE_URL is not set");
  });
  test("age maps to ok / degraded / down", () => {
    const now = Date.parse("2026-11-11T12:00:00Z");
    expect(freshnessOf(null, "2026-11-11T11:50:00Z", now).status).toBe("ok");
    expect(freshnessOf(null, "2026-11-11T11:00:00Z", now).status).toBe("degraded");
    expect(freshnessOf(null, "2026-11-11T08:00:00Z", now).status).toBe("down");
  });
});
