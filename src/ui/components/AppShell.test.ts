import { describe, expect, test } from "bun:test";
import { NAV, freshnessOf, isActive } from "./AppShell";
import { MARKET_TABS } from "./market/MarketTabs";

const activeCells = (p: string) => NAV.filter((n) => isActive(p, n.to)).map((n) => n.label);

describe("AppShell NAV", () => {
  test("five cells in order", () => {
    expect(NAV.map((n) => n.label)).toEqual(["RESEARCH", "TRADE", "MARKET", "ASK", "ENGINE"]);
  });

  test("MARKET is active for its five tabs and their drills", () => {
    for (const p of ["/moves", "/markets", "/markets/HYPE", "/sectors", "/state", "/cycles", "/cycles/eth"]) {
      expect(activeCells(p)).toEqual(["MARKET"]);
    }
  });

  test("MARKET cell links to /moves", () => {
    expect(NAV.find((n) => n.label === "MARKET")!.to).toBe("/moves");
  });

  test("RESEARCH is the landing: active for the board /, /lab/* and /branches/*", () => {
    expect(NAV[0]!.to).toBe("/");
    for (const p of ["/", "/lab", "/lab/search", "/lab/runs/abc", "/lab/rules/r1", "/branches", "/branches/b1"]) {
      expect(activeCells(p)).toEqual(["RESEARCH"]);
    }
  });

  test("other families stay on their own cell", () => {
    for (const p of ["/feed", "/terminal", "/watch", "/journal", "/theses", "/query", "/order", "/desk", "/asset/HYPE"]) {
      expect(activeCells(p)).toEqual(["TRADE"]);
    }
    expect(activeCells("/strategies/x")).toEqual(["ENGINE"]);
    expect(activeCells("/analyst")).toEqual(["ASK"]);
    expect(activeCells("/overview")).toEqual([]);
    expect(activeCells("/labx")).toEqual([]);
  });
});

describe("MarketTabs", () => {
  test("MOVES is the first tab", () => {
    expect(MARKET_TABS.map((t) => t.label)).toEqual(["MOVES", "PERPS", "SECTORS", "STATE", "CYCLES"]);
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
