import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { LabCatalogueEntry, LabRuleReport, LabStats } from "../../shared/lab.js";
import { labRoutes } from "../routes/lab.js";
import { handleMcp } from "./mcp.js";
import { labSave, LabDuplicateError, pulseOf, defaultServiceDeps } from "./service.js";
import { LabError } from "./search.js";
import { runLabTool, type LabToolDeps } from "./tools.js";
import { runTool, type ToolDeps } from "../llm/tools.js";

const app = new Hono().route("/lab", labRoutes);
const post = (path: string, body: unknown) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("/lab routes validate before touching data", () => {
  test("search rejects an unknown direction with the field", async () => {
    const res = await post("/lab/search", { direction: "sideways" });
    expect(res.status).toBe(400);
    expect((await res.json()).field).toBe("direction");
  });
  test("search rejects unknown keys", async () => {
    expect((await post("/lab/search", { direction: "long", leverage: 3 })).status).toBe(400);
  });
  test("evaluate rejects an unknown feature", async () => {
    const res = await post("/lab/evaluate", { rule: { direction: "long", conditions: [{ feature: "nope|z90", op: "<", q: 0.2 }] } });
    expect(res.status).toBe(400);
  });
  test("evaluate needs a threshold or q", async () => {
    const res = await post("/lab/evaluate", { rule: { direction: "long", conditions: [{ feature: "fng.value|raw", op: "<" }] } });
    expect(res.status).toBe(400);
  });
  test("save needs resolved thresholds", async () => {
    const res = await post("/lab/catalogue", { report: { text: "x", rule: { direction: "long", conditions: [{ feature: "fng.value|raw", op: "<", q: 0.2 }] } } });
    expect(res.status).toBe(400);
  });
  test("ids must be uuids", async () => {
    expect((await app.request("/lab/runs/abc")).status).toBe(400);
    expect((await app.request("/lab/catalogue/abc", { method: "DELETE" })).status).toBe(400);
  });
});

const stats = (sharpe: number): LabStats => ({
  from: "2020-01-01", to: "2024-01-01", days: 1461, totalReturnPct: 50, cagrPct: 10, sharpe, maxDrawdownPct: -30,
  exposure: 0.4, trades: 12, winRate: 0.6, benchmark: { totalReturnPct: 80, sharpe: 0.8, maxDrawdownPct: -70 },
});
const report: LabRuleReport = {
  rule: { direction: "long", conditions: [{ feature: "fng.value|raw", op: "<", q: 0.2, threshold: 25 }] },
  text: "LONG when Fear & Greed < 25",
  inSample: stats(1.2), walkForward: stats(1.0), outOfSample: stats(0.7),
  deflatedSharpe: 0.97, stability: 0.8, firingNow: true, asOf: "2026-10-07",
  equity: [{ ts: "2020-01-02", strategy: 1, benchmark: 1 }],
};

function fakeDeps(over: Partial<LabToolDeps> = {}): LabToolDeps & { saved: unknown[] } {
  const saved: unknown[] = [];
  return {
    saved,
    features: async () => ({ bases: [], transforms: [], groups: [] }),
    search: async () => ({ request: {} as never, generatedAt: "", range: { from: "a", to: "b", trainEnd: "c" }, bases: [], features: 3, trials: 99, elapsedMs: 1, results: [report], warnings: [], runId: null }),
    evaluate: async () => report,
    catalogue: async () => ({ entries: [], pulse: pulseOf([]) }),
    save: async (raw) => (saved.push(raw), { id: "00000000-0000-0000-0000-000000000000", createdAt: "2026-10-08T00:00:00.000Z" }),
    ...over,
  };
}

describe("lab tools", () => {
  test("search output drops the equity curve", async () => {
    const run = await runLabTool("lab_search", { direction: "long" }, fakeDeps());
    expect(run.isError).toBe(false);
    expect(run.content).not.toContain("equity");
    expect(JSON.parse(run.content).results[0].outOfSample.sharpe).toBe(0.7);
  });
  test("LabError becomes a readable error result", async () => {
    const run = await runLabTool("lab_search", {}, fakeDeps({ search: async () => { throw new LabError("need at least 730 days"); } }));
    expect(run.isError).toBe(true);
    expect(run.summary).toBe("need at least 730 days");
  });
  test("save evaluates the rule first and tags the source", async () => {
    const d = fakeDeps();
    const run = await runLabTool("lab_save_rule", { rule: report.rule }, d, "mcp");
    expect(run.isError).toBe(false);
    expect((d.saved[0] as { source: string }).source).toBe("mcp");
  });
  test("the analyst routes lab tools but cannot save", async () => {
    const deps = { lab: fakeDeps() } as unknown as ToolDeps;
    expect((await runTool("lab_evaluate_rule", { rule: report.rule }, deps)).isError).toBe(false);
    expect((await runTool("lab_save_rule", { rule: report.rule }, deps)).summary).toContain("unknown tool");
  });
});

describe("mcp", () => {
  test("initialize, list, call", async () => {
    const init = await handleMcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }, fakeDeps());
    expect((init!.result as { serverInfo: { name: string } }).serverInfo.name).toBe("hypertrade-lab");
    expect(await handleMcp({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    const list = await handleMcp({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const names = (list!.result as { tools: { name: string }[] }).tools.map((t) => t.name);
    expect(names).toEqual(["lab_features", "lab_search", "lab_evaluate_rule", "lab_catalogue", "lab_save_rule"]);
    const call = await handleMcp({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "lab_evaluate_rule", arguments: { rule: report.rule } } }, fakeDeps());
    const result = call!.result as { content: { text: string }[]; isError: boolean };
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content[0]!.text).text).toBe(report.text);
  });
  test("unknown methods and tools are JSON-RPC errors", async () => {
    expect((await handleMcp({ jsonrpc: "2.0", id: 4, method: "resources/list" }))!.error!.code).toBe(-32601);
    expect((await handleMcp({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "rm_rf" } }))!.error!.code).toBe(-32602);
  });
});

describe("pulse", () => {
  test("lean counts active long minus active short over all rules", () => {
    const entry = (direction: "long" | "short", firing: boolean): LabCatalogueEntry => ({
      id: "x", createdAt: "", note: null, source: "ui",
      report: { ...report, rule: { ...report.rule, direction } },
      live: { firingNow: firing, asOf: "", sinceSaved: null, full: stats(1) },
    });
    const p = pulseOf([entry("long", true), entry("long", true), entry("short", true), entry("short", false)]);
    expect(p.long).toEqual({ active: 2, total: 2 });
    expect(p.short).toEqual({ active: 1, total: 2 });
    expect(p.lean).toBe(0.25);
  });
});

describe("labSave", () => {
  test("refuses a rule already in the catalogue", async () => {
    const row = { id: "11111111-1111-1111-1111-111111111111", createdAt: new Date(), source: "ui", note: null, report };
    const deps = { ...defaultServiceDeps, listRules: async () => [row], insertRule: async () => row };
    await expect(labSave({ report }, deps)).rejects.toBeInstanceOf(LabDuplicateError);
    const fresh = { ...defaultServiceDeps, listRules: async () => [], insertRule: async () => row };
    expect((await labSave({ report }, fresh)).id).toBe(row.id);
  });
});
