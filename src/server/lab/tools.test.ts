import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { LAB_SERVER_INFO } from "../mcp/lab.js";
import { handleJsonRpc } from "../mcp/server.js";
import { ToolInputError, type Registry, type ToolDef } from "../mcp/types.js";
import { labRoutes } from "../routes/lab.js";
import { synthetic } from "./engine/testkit.js";
import { createLabService } from "./service.js";
import { memoryStore } from "./store.js";
import { LAB_INSTRUCTIONS, labPrompts, labTools } from "./tools.js";
import type { LabProvider, MetricDef } from "./types.js";

const base = synthetic({ seed: 1, drift: 0.012 });
const synProvider: LabProvider = {
  id: "syn",
  name: "Synthetic",
  notes: "test data",
  metrics: () =>
    ["a", "b", "c", "d"].map(
      (key): MetricDef => ({ id: `syn:${key}`, provider: "syn", key, name: key, category: "onchain", scope: "asset", description: key, lagDays: 0 }),
    ),
  fetch: async () => ({ t: [], v: [] }),
};

function testService() {
  return createLabService({
    store: memoryStore(),
    providers: [synProvider],
    async loadDataset(cfg) {
      const metrics = Object.fromEntries(cfg.metrics.map((m) => [m, base.metrics[m]!]));
      return { dataset: { ...base, asset: cfg.asset, metrics }, warnings: [] };
    },
  });
}

const tools = labTools(testService());
const tool = (name: string): ToolDef => tools.find((t) => t.name === name)!;
const registry = (): Registry => ({ tools, prompts: labPrompts(), instructions: LAB_INSTRUCTIONS, serverInfo: LAB_SERVER_INFO });
const search = { asset: "SYN", metrics: ["syn:a", "syn:b"], transforms: ["raw", "z"], windows: [30], horizonDays: 2, trials: 4 };
const rule = {
  asset: "SYN",
  direction: "long",
  horizonDays: 2,
  conditions: [
    { feature: "syn:a|z|30", op: "<", threshold: -1 },
    { feature: "syn:b|raw|0", op: ">=", threshold: 0 },
  ],
};

async function fieldOf(name: string, args: unknown): Promise<string | undefined> {
  const err = await tool(name)
    .run(args, { source: "api" })
    .then(
      () => null,
      (e) => e,
    );
  expect(err).toBeInstanceOf(ToolInputError);
  return (err as ToolInputError).field;
}

describe("lab tools: definitions", () => {
  test("the twelve contract tools, in order", () => {
    expect(tools.map((t) => t.name)).toEqual([
      "lab_list_providers",
      "lab_list_metrics",
      "lab_search",
      "lab_get_run",
      "lab_list_runs",
      "lab_evaluate_rule",
      "lab_sensitivity",
      "lab_catalogue_list",
      "lab_catalogue_save",
      "lab_catalogue_remove",
      "lab_catalogue_health",
      "lab_market_pulse",
    ]);
  });

  test("schemas are closed objects; required args match the contract", () => {
    for (const t of tools) {
      expect(t.inputSchema.type).toBe("object");
      expect(t.inputSchema.additionalProperties).toBe(false);
      expect(t.description.length).toBeGreaterThan(80);
    }
    const required = Object.fromEntries(tools.map((t) => [t.name, t.inputSchema.required ?? []]));
    expect(required).toMatchObject({
      lab_search: ["asset", "metrics"],
      lab_get_run: ["id"],
      lab_evaluate_rule: ["rule"],
      lab_sensitivity: ["rule"],
      lab_catalogue_save: ["rule", "name"],
      lab_catalogue_remove: ["id"],
      lab_list_runs: [],
      lab_market_pulse: [],
    });
    expect(Object.keys(tool("lab_search").inputSchema.properties).sort()).toEqual(
      ["asset", "direction", "metrics", "transforms", "windows", "horizonDays", "labelQuantile", "customZones", "objective", "trials", "folds", "minSupport", "slippageBps", "topK", "from", "to", "price", "seed"].sort(),
    );
  });

  test("annotations: read-only vs writing tools", () => {
    const readOnly = tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name);
    expect(readOnly.sort()).toEqual(
      ["lab_list_providers", "lab_list_metrics", "lab_get_run", "lab_list_runs", "lab_evaluate_rule", "lab_sensitivity", "lab_catalogue_list", "lab_catalogue_health", "lab_market_pulse"].sort(),
    );
    expect(tool("lab_search").annotations).toMatchObject({ readOnlyHint: false, openWorldHint: true });
    expect(tool("lab_catalogue_save").annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(tool("lab_catalogue_remove").annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });
});

describe("lab tools: argument validation", () => {
  test("zod failures → ToolInputError with the field", async () => {
    expect(await fieldOf("lab_search", { asset: "SYN" })).toBe("metrics");
    expect(await fieldOf("lab_search", { ...search, trials: 500 })).toBe("trials");
    expect(await fieldOf("lab_search", { ...search, horizon_days: 3 })).toBe("horizon_days");
    expect(await fieldOf("lab_list_runs", { limit: 0 })).toBe("limit");
    expect(await fieldOf("lab_list_metrics", { category: "astrology" })).toBe("category");
    expect(await fieldOf("lab_get_run", {})).toBe("id");
    expect(await fieldOf("lab_evaluate_rule", { rule: { ...rule, direction: "up" } })).toBe("rule.direction");
    expect(await fieldOf("lab_evaluate_rule", { rule, from: "June 1" })).toBe("from");
    expect(await fieldOf("lab_catalogue_save", { rule, name: " " })).toBe("name");
    expect(await fieldOf("lab_catalogue_save", { rule, name: "x", runId: "run-1" })).toBe("runId");
    expect(await fieldOf("lab_catalogue_list", { direction: "sideways" })).toBe("direction");
    expect(await fieldOf("lab_catalogue_health", { extra: 1 })).toBe("extra");
  });

  test("valid calls reach the service", async () => {
    expect(await tool("lab_list_metrics").run({ provider: "syn" }, { source: "api" })).toMatchObject({ metrics: [{ id: "syn:a" }, { id: "syn:b" }, { id: "syn:c" }, { id: "syn:d" }] });
    expect(await tool("lab_list_providers").run({}, { source: "api" })).toEqual({ providers: [{ id: "syn", name: "Synthetic", notes: "test data", metrics: 4 }] });
    const ev = (await tool("lab_evaluate_rule").run({ rule }, { source: "api" })) as { text: string; sensitivity?: unknown };
    expect(ev.text).toBe("syn:a z(30) < -1 AND syn:b raw ≥ 0");
    expect(ev.sensitivity).toBeUndefined();
  });
});

describe("lab tools: end to end", () => {
  test("MCP tools/call lab_search → structured { runId, result }; then lab_get_run", async () => {
    const reply = (await handleJsonRpc(registry(), { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "lab_search", arguments: search } }, { source: "mcp", deadlineMs: 50_000 })) as {
      result: { isError: boolean; structuredContent: { runId: string; result: { rules: unknown[]; config: { trials: number } } } };
    };
    expect(reply.result.isError).toBe(false);
    const { runId, result } = reply.result.structuredContent;
    expect(runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.rules.length).toBeGreaterThan(0);
    expect(result.config.trials).toBe(4);

    const run = (await tool("lab_get_run").run({ id: runId }, { source: "mcp" })) as { source: string; status: string };
    expect(run).toMatchObject({ source: "mcp", status: "ok" });
  }, 20_000);

  test("MCP tools/call with bad args → isError naming the field", async () => {
    const reply = (await handleJsonRpc(registry(), { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "lab_search", arguments: { asset: "SYN", metrics: [] } } }, { source: "mcp" })) as {
      result: { isError: boolean; content: Array<{ text: string }> };
    };
    expect(reply.result.isError).toBe(true);
    expect(reply.result.content[0]!.text).toStartWith("Invalid arguments (metrics)");
  });

  test("REST POST /lab/tools/lab_search → { ok, result }; bad args → 400 with field", async () => {
    const app = new Hono().route("/lab", labRoutes(registry, { env: {} }));
    const post = (name: string, body: unknown) =>
      app.request(`/lab/tools/${name}`, { method: "POST", headers: { "content-type": "application/json", "x-lab-source": "ui" }, body: JSON.stringify(body) });

    const ok = await post("lab_search", search);
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { ok: boolean; result: { runId: string } };
    expect(body.ok).toBe(true);
    const runs = (await (await post("lab_list_runs", { limit: 5 })).json()) as { result: { runs: Array<{ id: string; source: string }> } };
    expect(runs.result.runs.find((r) => r.id === body.result.runId)?.source).toBe("ui");

    const bad = await post("lab_search", { ...search, windows: [1] });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ ok: false, field: "windows.0" });

    const listed = (await (await app.request("/lab/tools")).json()) as { tools: Array<{ name: string }> };
    expect(listed.tools.length).toBe(12);
  }, 20_000);

  test("autoresearch prompt and instructions", async () => {
    const reply = (await handleJsonRpc(registry(), { jsonrpc: "2.0", id: 3, method: "prompts/get", params: { name: "autoresearch", arguments: { asset: "ETH", direction: "short", goal: "fade euphoria" } } }, { source: "mcp" })) as {
      result: { messages: Array<{ content: { text: string } }> };
    };
    const text = reply.result.messages[0]!.content.text;
    expect(text).toContain("Research short heuristics for ETH");
    expect(text).toContain("Goal: fade euphoria.");
    expect(text).toContain('"direction": "short"');
    expect(text).toContain("walkForward Sharpe > 1, holdout Sharpe > 0 and stability ≥ 0.5");
    expect(text).toContain("at most 5 searches");
    expect(LAB_INSTRUCTIONS).toContain("never used for selection");

    const init = (await handleJsonRpc(registry(), { jsonrpc: "2.0", id: 4, method: "initialize", params: { protocolVersion: "2025-06-18" } }, { source: "mcp" })) as {
      result: { instructions: string; serverInfo: { name: string } };
    };
    expect(init.result.instructions).toBe(LAB_INSTRUCTIONS);
    expect(init.result.serverInfo.name).toBe("hypertrade-lab");
  });
});
