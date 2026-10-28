import { describe, expect, test } from "bun:test";
import { MemoryIntelStore, type NewAlert } from "../intel/store.js";
import { MemoryPlatformStore } from "../platform/store-memory.js";
import type { OpportunityInput } from "../platform/store.js";
import type { PositionsResponse } from "../../shared/intel.js";
import { READ_TOOL_NAMES } from "../desk/tools.js";
import { intelReadDeps } from "./intelTools.js";
import { TOOL_SPECS, runTool, type ToolDeps } from "./tools.js";

const NOW = new Date("2026-10-28T12:00:00Z");
const newAlert = (over: Partial<NewAlert> = {}): NewAlert => ({
  kind: "mapper", ref: "c1", window: null, asset: "SOL", title: "Jito exploit", eventType: "exploit",
  line: { tag: "hypothesis", text: "Long SOL." }, path: [], edgeType: null, hops: 0, pathWeight: 1,
  sources: [{ label: "a", url: "https://a" }, { label: "b", url: "https://b" }, { label: "c", url: "https://c" }],
  materiality: 0.4, pricedIn: null, route: "push", ...over,
});
const opp = (over: Partial<OpportunityInput> = {}): OpportunityInput => ({
  coin: "BTC", direction: "long", setupKind: "breakout", tradeType: "directional", score: 2, scoreVersion: "v1",
  tags: ["oi_up"], liquidityTier: 1, regime: "new_longs", invalidation: "x", entryPx: 62000, stopPx: 61000, targetPx: 64000, invalidationPx: 61000, ...over,
});
const created = { features: { features: {}, inputs: {} }, market: { mark: 1 }, score: 1, scoreVersion: "v1" };
const exposure: PositionsResponse = {
  positions: [{ id: "manual:1", source: "manual", asset: "ETH", side: "long", size: 1, entryPx: 3000, markPx: 3100, stopPx: null, leverage: 2, venue: "hl", notionalUsd: 3100, unrealizedPnl: 100 }],
  sources: [], totalNotionalUsd: 3100,
};

async function setup(platformOn = true) {
  const intel = new MemoryIntelStore();
  const platform = new MemoryPlatformStore();
  await platform.upsertOpportunity(opp({ score: 1 }), created);
  await platform.upsertOpportunity(opp({ coin: "ETH", score: 5 }), created);
  await intel.insertAlert(newAlert());
  const deps = { intel: intelReadDeps({ intel, platform: () => (platformOn ? platform : null), exposure: async () => exposure, now: () => NOW }) } as ToolDeps;
  return { intel, platform, deps };
}
const call = async (deps: ToolDeps, name: string, input: unknown = {}) => {
  const r = await runTool(name, input, deps);
  return { ...r, json: JSON.parse(r.content) };
};

describe("intel tools", () => {
  test("opportunities come sorted by score and respect limit and status", async () => {
    const { deps } = await setup();
    const all = await call(deps, "get_opportunities");
    expect(all.json.opportunities.map((o: any) => o.coin)).toEqual(["ETH", "BTC"]);
    expect(all.json.opportunities[0].trace).toBeUndefined();
    expect((await call(deps, "get_opportunities", { limit: 1 })).json.opportunities).toHaveLength(1);
    expect((await call(deps, "get_opportunities", { status: ["ready"] })).json.opportunities).toHaveLength(0);
  });

  test("platform offline is a tool error, not a throw", async () => {
    const { deps } = await setup(false);
    const r = await call(deps, "get_opportunities");
    expect(r.isError).toBe(true);
    expect(r.json.error).toContain("platform offline");
  });

  test("alerts: trimmed rows, window and kind filters", async () => {
    const { deps } = await setup();
    // The memory store stamps alerts with the real clock; move the tool's clock around it.
    const at = (ms: number): ToolDeps => ({ intel: { ...deps.intel!, now: () => new Date(Date.now() + ms) } }) as ToolDeps;
    const r = await call(at(1000), "get_alerts", { kind: "mapper" });
    expect(r.json.alerts).toHaveLength(1);
    expect(r.json.alerts[0].sources).toHaveLength(2);
    expect(r.json.alerts[0].path).toBeUndefined();
    expect((await call(at(1000), "get_alerts", { kind: "flow" })).json.alerts).toHaveLength(0);
    expect((await call(at(3 * 3_600_000), "get_alerts", { hours: 1 })).json.alerts).toHaveLength(0);
  });

  test("brief is null before any run, then the stored one", async () => {
    const { deps, intel } = await setup();
    expect((await call(deps, "get_intel_brief")).json).toEqual({ brief: null });
    await intel.insertBrief({ surface: "ui", since: NOW.toISOString(), items: [], alerts: [], catalysts: [], lines: [{ tag: "hypothesis", text: "BTC OI up." }], silent: false });
    const r = await call(deps, "get_intel_brief", { surface: "ui" });
    expect(r.json.brief.lines[0].text).toBe("BTC OI up.");
    expect((await call(deps, "get_intel_brief", { surface: "cron" })).json).toEqual({ brief: null });
  });

  test("exposure and theses", async () => {
    const { deps } = await setup();
    const e = await call(deps, "get_exposure");
    expect(e.json.totalNotionalUsd).toBe(3100);
    expect(e.json.positions[0].asset).toBe("ETH");
    expect((await call(deps, "get_theses")).json).toEqual({ theses: [] });
  });

  test("bad input is rejected at the boundary; output is capped", async () => {
    const { deps } = await setup();
    expect((await call(deps, "get_opportunities", { limit: 500 })).isError).toBe(true);
    expect((await call(deps, "get_opportunities", { status: ["bogus"] })).isError).toBe(true);
    expect((await call(deps, "get_alerts", { extra: 1 })).isError).toBe(true);
    const big = { intel: { ...deps.intel!, exposure: async () => ({ ...exposure, positions: Array.from({ length: 200 }, (_, i) => ({ ...exposure.positions[0]!, id: `m${i}`, venue: "x".repeat(200) })) }) } } as ToolDeps;
    const r = await runTool("get_exposure", {}, big);
    expect(r.content.length).toBeLessThan(12_100);
  });

  test("not connected without deps, and the tools are read-only and reach the desk", async () => {
    expect((await runTool("get_exposure", {}, {} as ToolDeps)).isError).toBe(true);
    for (const n of ["get_opportunities", "get_alerts", "get_intel_brief", "get_exposure", "get_theses"]) {
      expect(TOOL_SPECS.some((t) => t.name === n)).toBe(true);
      expect(READ_TOOL_NAMES).toContain(n);
    }
  });
});
