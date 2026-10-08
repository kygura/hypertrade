import { describe, expect, test } from "bun:test";
import { createAnalystRoutes } from "../routes/analyst.js";
import { SIM_TOOL_SPEC, buildSimSystemPrompt } from "./sim.js";
import { SimIntentSchema } from "../../shared/intent.js";
import { AllocationSchema } from "../../shared/schemas.js";
import type { Conversation, LLMProvider, StepResult, ToolOutcome, ToolSpec } from "./provider.js";
import type { IntentDeps } from "../sim/intent.js";
import type { DailyClose } from "../sim/engine.js";

const DAY = 86400000;
const t0 = Date.parse("2024-01-01");
const btc: DailyClose[] = Array.from({ length: 90 }, (_, i) => ({ ts: t0 + i * DAY, c: 100 + i }));
const simDeps: IntentDeps = { backfill: async () => {}, loadCandles: async () => ({ BTC: btc }), now: () => t0 };

const usage = { input_tokens: 1, output_tokens: 1 };
const callStep = (input: unknown): StepResult => ({ stop: "tool_use", usage, toolCalls: [{ id: "c1", name: "simulate_paths", input }] }) as StepResult;
const endStep = { stop: "end", usage, toolCalls: [] } as unknown as StepResult;

function fake() {
  const p = { tools: [] as ToolSpec[], system: "", results: [] as ToolOutcome[][], input: undefined as unknown };
  const provider: LLMProvider = {
    id: "anthropic",
    model: "m",
    webSearch: false,
    start(system): Conversation {
      p.system = system;
      let i = 0;
      return {
        step: async (tools) => {
          p.tools = tools;
          return i++ === 0 ? callStep(p.input) : endStep;
        },
        addToolResults: (r) => void p.results.push(r),
      };
    },
  };
  return { p, provider };
}

async function query(input: unknown, mode: string | undefined = "sim") {
  const f = fake();
  f.p.input = input;
  const app = createAnalystRoutes({ resolve: () => f.provider, simDeps });
  const res = await app.request("/query", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: "q", mode }) });
  const text = await res.text();
  const events = !res.ok ? [] : text
    .split("\n\n")
    .filter(Boolean)
    .map((fr) => ({ event: fr.match(/^event: (.*)$/m)![1]!, data: JSON.parse(fr.match(/^data: (.*)$/m)![1]!) }));
  return { res, events, ...f };
}

const valid = {
  title: "t",
  assumptions: ["stack $10k"],
  branches: [{ name: "b", config: { startDate: "2024-01-01", initialCapitalUsd: 1000, allocations: [{ coin: "BTC", weightPct: 100 }], rebalance: "none" } }],
};

describe("analyst sim mode", () => {
  test("invalid intents (extra key, leverage 80) give an error tool_result and no sim_result", async () => {
    for (const bad of [{ ...valid, extra: 1 }, { ...valid, branches: [{ name: "b", config: { ...valid.branches[0]!.config, allocations: [{ coin: "BTC", weightPct: 100, leverage: 80 }] } }] }]) {
      const { events, p } = await query(bad);
      expect(events.some((e) => e.event === "sim_result")).toBe(false);
      expect(events.find((e) => e.event === "tool_result")!.data).toMatchObject({ id: "c1", ok: false });
      expect(p.results[0]![0]!.isError).toBe(true);
    }
  });

  test("valid intent: sim_result before tool_result with the same id, compact tool content", async () => {
    const { events, p } = await query(valid);
    const names = events.map((e) => e.event);
    expect(names.indexOf("sim_result")).toBeLessThan(names.indexOf("tool_result"));
    const sim = events.find((e) => e.event === "sim_result")!.data;
    expect(sim.id).toBe("c1");
    expect(events.find((e) => e.event === "tool_result")!.data).toMatchObject({ id: "c1", ok: true });
    expect(sim.branches[0].result.equity.length).toBeGreaterThan(1);
    const out = p.results[0]![0]!;
    expect(out.isError).toBe(false);
    const b = JSON.parse(out.content).branches[0];
    expect(Object.keys(b)).toEqual(expect.arrayContaining(["name", "finalValue", "totalReturnPct", "cagrPct", "maxDrawdownPct", "vsBtcPct", "startDate", "warnings"]));
    expect(out.content).not.toContain("equity");
    expect(p.tools.map((t) => t.name)).toContain("simulate_paths");
    expect(p.system).toContain("simulate_paths");
  });

  test("ask mode has no simulate_paths; bogus mode is a 400", async () => {
    const { p } = await query({}, "ask");
    expect(p.tools.map((t) => t.name)).not.toContain("simulate_paths");
    const { res } = await query({}, "bogus");
    expect(res.status).toBe(400);
  });

  test("prompt keeps the disclaimer", () => {
    expect(buildSimSystemPrompt(false)).toContain("Not financial advice");
  });

  test("tool JSON schema keys mirror SimIntentSchema / AllocationSchema", () => {
    const props = SIM_TOOL_SPEC.input_schema.properties as any;
    expect(Object.keys(props).sort()).toEqual(Object.keys(SimIntentSchema.shape).sort());
    const alloc = props.branches.items.properties.config.properties.allocations.items.properties;
    expect(Object.keys(alloc).sort()).toEqual(Object.keys(AllocationSchema._def.schema.shape).sort());
  });
});
