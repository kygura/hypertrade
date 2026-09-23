import { describe, expect, test } from "bun:test";
import { createAnalystRoutes, runAnalyst, type AnalystEvent } from "./analyst";
import type { Conversation, LLMProvider, StepHooks, StepOptions, StepResult, ToolOutcome, ToolSpec, Turn } from "../llm/provider";
import type { ToolDeps } from "../llm/tools";
import { DISCLAIMER } from "../llm/system";

// A scripted provider: each step() runs the next script entry, which can
// stream text, call server-tool hooks, and return tool calls.
type Script = (hooks: StepHooks, opts: StepOptions, tools: ToolSpec[]) => Promise<StepResult> | StepResult;

class FakeProvider implements LLMProvider {
  readonly id = "anthropic" as const;
  readonly model = "fake-model";
  readonly webSearch = true;
  system = "";
  question = "";
  history: Turn[] = [];
  toolResults: ToolOutcome[][] = [];
  finals: boolean[] = [];
  constructor(private readonly scripts: Script[]) {}
  start(system: string, history: Turn[], question: string): Conversation {
    this.system = system;
    this.history = history;
    this.question = question;
    let i = 0;
    return {
      step: async (tools, hooks, opts) => {
        this.finals.push(!!opts.final);
        const s = this.scripts[Math.min(i++, this.scripts.length - 1)]!;
        return s(hooks, opts, tools);
      },
      addToolResults: (r) => void this.toolResults.push(r),
    };
  }
}

const usage = { input_tokens: 10, output_tokens: 5 };

const deps: ToolDeps = {
  marketstateLatest: () => ({ generated_at: "2026-09-22T08:00:00Z", headline: "h" }),
  marketstateHistory: () => [{ date: "2026-09-21", data: { headline: "old" } }],
  sectors: async () => ({ generated_at: "2026-09-22", sectors: [{ id: "ai" }, { id: "rwa" }], rotations: [{ from: "ai", to: "rwa" }] }),
  metricsSummary: async (ids) => ids.map((id) => ({ seriesId: id, latest: 1 })),
  series: async (id) => [{ ts: "2026-09-01", value: 1 }],
  hlMarkets: async () => ({ fetchedAt: "2026-09-23T00:00:00Z", markets: [] }),
  engine: async () => ({ status: 503, json: { error: "engine not configured" } }),
};

/** Parses an SSE body into [{event, data}] and checks the framing. */
function parseSSE(body: string): Array<{ event: string; data: any }> {
  const out: Array<{ event: string; data: any }> = [];
  for (const frame of body.split("\n\n")) {
    if (!frame.trim()) continue;
    const lines = frame.split("\n");
    const ev = lines.find((l) => l.startsWith("event: "));
    const data = lines.filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n");
    expect(ev).toBeDefined();
    out.push({ event: ev!.slice(7), data: JSON.parse(data) });
  }
  return out;
}

function post(app: ReturnType<typeof createAnalystRoutes>, body: unknown) {
  return app.request("/query", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

describe("/analyst", () => {
  test("503 analyst not configured when no provider resolves", async () => {
    const app = createAnalystRoutes({ resolve: () => null });
    const res = await post(app, { question: "hi" });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "analyst not configured" });
    const st = await app.request("/status");
    expect(st.status).toBe(503);
  });

  test("400 on missing question", async () => {
    const app = createAnalystRoutes({ resolve: () => new FakeProvider([]) });
    const res = await post(app, { question: "" });
    expect(res.status).toBe(400);
  });

  test("status lists tools and web search availability", async () => {
    const app = createAnalystRoutes({ resolve: () => new FakeProvider([]) });
    const body = (await (await app.request("/status")).json()) as any;
    expect(body.configured).toBe(true);
    expect(body.model).toBe("fake-model");
    expect(body.tools.map((t: any) => t.name)).toContain("get_engine_decisions");
    expect(body.tools.find((t: any) => t.name === "web_search").available).toBe(true);
  });

  test("tool loop streams SSE: text, tool_call, tool_result, citations, done", async () => {
    const provider = new FakeProvider([
      (hooks) => {
        hooks.onText("Checking sectors. ");
        hooks.onServerToolCall?.({ id: "srv_1", name: "web_search", input: { query: "ai tokens rotation" } });
        hooks.onServerToolResult?.("srv_1", "web_search", true, "3 results");
        return { stop: "tool_use", toolCalls: [{ id: "tu_1", name: "get_sectors", input: {} }, { id: "tu_2", name: "get_engine_strategies", input: {} }], usage };
      },
      (hooks) => {
        hooks.onText("AI is rotating into RWA. ");
        hooks.onCitation?.({ url: "https://example.com/a", title: "A" });
        hooks.onCitation?.({ url: "https://example.com/a", title: "A dup" });
        hooks.onText(DISCLAIMER);
        return { stop: "end", toolCalls: [], usage };
      },
    ]);
    const app = createAnalystRoutes({ resolve: () => provider, deps });
    const res = await post(app, { question: "which sector is rotating", history: [{ role: "user", content: "earlier" }, { role: "assistant", content: "answer" }] });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const events = parseSSE(await res.text());
    expect(events.map((e) => e.event)).toEqual([
      "text", "tool_call", "tool_result", "tool_call", "tool_call", "tool_result", "tool_result", "text", "text", "citations", "done",
    ]);
    expect(events[1]!.data).toMatchObject({ name: "web_search", server: true });
    expect(events[3]!.data).toMatchObject({ id: "tu_1", name: "get_sectors", server: false });
    const results = events.filter((e) => e.event === "tool_result" && !e.data.id.startsWith("srv"));
    expect(results.find((r) => r.data.name === "get_sectors")!.data).toMatchObject({ ok: true, summary: expect.stringContaining("2 sectors") });
    // Engine unset degrades to an is_error result, not a crash.
    expect(results.find((r) => r.data.name === "get_engine_strategies")!.data.ok).toBe(false);
    expect(events.at(-2)!.data.citations).toEqual([{ url: "https://example.com/a", title: "A" }]);
    expect(events.at(-1)!.data).toEqual({ usage: { input_tokens: 20, output_tokens: 10 }, model: "fake-model", provider: "anthropic", rounds: 1, stop: "end" });
    // Tool results went back to the provider in one batch, engine note included.
    expect(provider.toolResults.length).toBe(1);
    expect(provider.toolResults[0]!.map((r) => r.name)).toEqual(["get_sectors", "get_engine_strategies"]);
    expect(provider.toolResults[0]![1]!.content).toContain("ENGINE_URL unset");
    expect(provider.history.length).toBe(2);
    expect(provider.question).toMatch(/^\[current time \d{4}-/);
    expect(provider.system).toContain("not financial advice");
  });

  test("stops after the tool-round cap with a final no-tools round", async () => {
    const loop: Script = () => ({ stop: "tool_use", toolCalls: [{ id: `t${Math.random()}`, name: "get_metrics_summary", input: {} }], usage });
    const provider = new FakeProvider([loop]);
    const events: AnalystEvent[] = [];
    await runAnalyst({ provider, question: "q", deps, maxRounds: 3 }, (e) => void events.push(e));
    expect(provider.finals).toEqual([false, false, false, true]);
    const done = events.at(-1) as Extract<AnalystEvent, { type: "done" }>;
    expect(done.type).toBe("done");
    expect(done.rounds).toBe(3);
    expect(done.stop).toBe("max_rounds");
    expect(events.filter((e) => e.type === "tool_call").length).toBe(3);
  });

  test("default cap is 8 tool rounds", async () => {
    const provider = new FakeProvider([() => ({ stop: "tool_use", toolCalls: [{ id: "x", name: "get_sectors", input: {} }], usage })]);
    const events: AnalystEvent[] = [];
    await runAnalyst({ provider, question: "q", deps }, (e) => void events.push(e));
    expect(provider.finals.filter((f) => !f).length).toBe(8);
    expect(provider.finals.at(-1)).toBe(true);
  });

  test("timeout aborts the provider and reports it", async () => {
    const provider = new FakeProvider([
      (hooks, opts) =>
        new Promise<StepResult>((_, reject) => {
          hooks.onText("thinking about it");
          opts.signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    ]);
    const app = createAnalystRoutes({ resolve: () => provider, deps, timeoutMs: 30 });
    const events = parseSSE(await (await post(app, { question: "slow" })).text());
    expect(events.map((e) => e.event)).toEqual(["text", "error", "done"]);
    expect(events[1]!.data.error).toContain("timeout");
    expect(events[2]!.data.stop).toBe("timeout");
  });

  test("provider failure becomes an error event without leaking details", async () => {
    const provider = new FakeProvider([
      () => {
        throw Object.assign(new Error("bad key sk-secret"), { status: 401 });
      },
    ]);
    const events: AnalystEvent[] = [];
    await runAnalyst({ provider, question: "q", deps }, (e) => void events.push(e));
    expect(events[0]).toEqual({ type: "error", error: "analyst provider rejected the credentials" });
    expect(JSON.stringify(events)).not.toContain("sk-secret");
  });

  test("invalid tool input returns an is_error result", async () => {
    const provider = new FakeProvider([
      () => ({ stop: "tool_use", toolCalls: [{ id: "a", name: "get_series", input: { id: "" } }, { id: "b", name: "place_order", input: {} }], usage }),
      () => ({ stop: "end", toolCalls: [], usage }),
    ]);
    const events: AnalystEvent[] = [];
    await runAnalyst({ provider, question: "q", deps }, (e) => void events.push(e));
    const res = events.filter((e) => e.type === "tool_result") as Array<Extract<AnalystEvent, { type: "tool_result" }>>;
    expect(res.map((r) => r.ok)).toEqual([false, false]);
    expect(res[1]!.summary).toBe("unknown tool place_order");
  });
});
