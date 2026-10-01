import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolveProvider, DEFAULT_MODEL, type StepHooks } from "./provider.js";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAICompatibleProvider } from "./openai.js";
import { DISCLAIMER, FORECAST_RULE, HARD_RULE, HEDGE_VOCABULARY, buildSystemPrompt } from "./system.js";
import { TOOL_SPECS, runTool, type ToolDeps } from "./tools.js";

const ROUTINE = readFileSync(new URL("../../../ROUTINE.md", import.meta.url), "utf8");

function sse(events: Array<{ event?: string; data: unknown }>): Response {
  const body = events.map((e) => `${e.event ? `event: ${e.event}\n` : ""}data: ${typeof e.data === "string" ? e.data : JSON.stringify(e.data)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function hooks() {
  const text: string[] = [];
  const server: string[] = [];
  const cites: string[] = [];
  const h: StepHooks = {
    onText: (d) => void text.push(d),
    onServerToolCall: (c) => void server.push(`call:${c.name}`),
    onServerToolResult: (_id, name, ok, summary) => void server.push(`result:${name}:${ok}:${summary}`),
    onCitation: (c) => void cites.push(c.url),
  };
  return { h, text, server, cites };
}

describe("resolveProvider", () => {
  test("unconfigured without ANALYST_API_KEY", () => {
    expect(resolveProvider({})).toBeNull();
    expect(resolveProvider({ ANALYST_PROVIDER: "openai-compatible", ANALYST_API_KEY: "k" })).toBeNull(); // needs base URL
    expect(resolveProvider({ ANALYST_PROVIDER: "mystery", ANALYST_API_KEY: "k" })).toBeNull();
  });
  test("anthropic by default with the default model; overridable", () => {
    const p = resolveProvider({ ANALYST_API_KEY: "k" })!;
    expect(p.id).toBe("anthropic");
    expect(p.model).toBe(DEFAULT_MODEL);
    expect(DEFAULT_MODEL).toBe("claude-opus-5-5");
    expect(p.webSearch).toBe(true);
    expect(resolveProvider({ ANALYST_API_KEY: "k", ANALYST_MODEL: "claude-fable-5-1" })!.model).toBe("claude-fable-5-1");
  });
  test("openai-compatible has no web search", () => {
    const p = resolveProvider({ ANALYST_PROVIDER: "openai-compatible", ANALYST_API_KEY: "k", ANALYST_BASE_URL: "http://llm.local/v1", ANALYST_MODEL: "m" })!;
    expect(p.id).toBe("openai-compatible");
    expect(p.webSearch).toBe(false);
  });
});

describe("system prompt", () => {
  test("carries ROUTINE.md's hard rule, hedge vocabulary and disclaimer verbatim", () => {
    expect(ROUTINE).toContain(HARD_RULE);
    expect(ROUTINE).toContain(HEDGE_VOCABULARY);
    expect(ROUTINE.replace(/\n\s*/g, " ")).toContain(FORECAST_RULE.replace(/\n\s*/g, " "));
    expect(ROUTINE).toContain(DISCLAIMER);
    const s = buildSystemPrompt(true);
    for (const part of [HARD_RULE, HEDGE_VOCABULARY, FORECAST_RULE, DISCLAIMER]) expect(s).toContain(part);
    expect(s).toContain("- web_search — provider-hosted web search");
    expect(buildSystemPrompt(false)).toContain("web_search (unavailable) — only with Anthropic models");
    expect(s).not.toMatch(/\d{4}-\d{2}-\d{2}T/); // no timestamps: the prefix caches
  });
});

describe("AnthropicProvider", () => {
  test("streams text, surfaces web search and citations, returns tool calls", async () => {
    let sent: any;
    let headers = new Headers();
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      headers = new Headers(init.headers);
      return sse([
        { event: "message_start", data: { type: "message_start", message: { id: "m1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0 } } } },
        { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "server_tool_use", id: "srv_1", name: "web_search", input: {} } } },
        { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"query\":\"monad\"}" } } },
        { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
        { event: "content_block_start", data: { type: "content_block_start", index: 1, content_block: { type: "web_search_tool_result", tool_use_id: "srv_1", content: [{ type: "web_search_result", url: "https://ex.com/1", title: "One", encrypted_content: "x", page_age: null }] } } },
        { event: "content_block_stop", data: { type: "content_block_stop", index: 1 } },
        { event: "content_block_start", data: { type: "content_block_start", index: 2, content_block: { type: "text", text: "", citations: null } } },
        { event: "content_block_delta", data: { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "Monad is up." } } },
        { event: "content_block_delta", data: { type: "content_block_delta", index: 2, delta: { type: "citations_delta", citation: { type: "web_search_result_location", url: "https://ex.com/1", title: "One", cited_text: "up", encrypted_index: "e" } } } },
        { event: "content_block_stop", data: { type: "content_block_stop", index: 2 } },
        { event: "content_block_start", data: { type: "content_block_start", index: 3, content_block: { type: "tool_use", id: "tu_1", name: "get_sectors", input: {} } } },
        { event: "content_block_delta", data: { type: "content_block_delta", index: 3, delta: { type: "input_json_delta", partial_json: "{}" } } },
        { event: "content_block_stop", data: { type: "content_block_stop", index: 3 } },
        { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 42 } } },
        { event: "message_stop", data: { type: "message_stop" } },
      ]);
    }) as unknown as typeof fetch;
    const p = new AnthropicProvider({ apiKey: "k", model: "claude-opus-5-5", fetch: fakeFetch });
    const conv = p.start("SYSTEM", [{ role: "user", content: "before" }, { role: "assistant", content: "ok" }], "now?");
    const { h, text, server, cites } = hooks();
    const res = await conv.step(TOOL_SPECS, h, { signal: new AbortController().signal });
    expect(text.join("")).toBe("Monad is up.");
    expect(server).toEqual(["call:web_search", "result:web_search:true:1 results: One"]);
    expect(cites).toEqual(["https://ex.com/1"]);
    expect(res.stop).toBe("tool_use");
    expect(res.toolCalls).toEqual([{ id: "tu_1", name: "get_sectors", input: {} }]);
    expect(res.usage).toEqual({ input_tokens: 100, output_tokens: 42 });
    // Request shape: model, effort, tool list with server web search, cached system.
    expect(sent.model).toBe("claude-opus-5-5");
    expect(sent.stream).toBe(true);
    expect(sent.output_config).toEqual({ effort: "medium" });
    expect(sent.tool_choice).toEqual({ type: "auto" });
    expect(sent.tools.at(-1)).toMatchObject({ type: "web_search_20260209", name: "web_search" });
    expect(sent.tools.map((t: any) => t.name)).toContain("get_engine_decisions");
    expect(sent.system[0]).toMatchObject({ type: "text", text: "SYSTEM", cache_control: { type: "ephemeral" } });
    expect(sent.messages.map((m: any) => m.role)).toEqual(["user", "assistant", "user"]);
    // Summarized thinking feeds the reasoning panel; refusal fallbacks are on by default.
    expect(sent.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(sent.fallbacks).toBe("default");
    expect(headers.get("anthropic-beta")).toContain("server-side-fallback-2026-07-01");

    conv.addToolResults([{ id: "tu_1", name: "get_sectors", content: "{}", isError: false }]);
    await conv.step(TOOL_SPECS, h, { signal: new AbortController().signal, final: true }).catch(() => undefined);
    expect(sent.tool_choice).toEqual({ type: "none" });
    expect(sent.messages.at(-2).role).toBe("assistant");
    expect(sent.messages.at(-1).content[0]).toMatchObject({ type: "tool_result", tool_use_id: "tu_1" });
  });
});

describe("AnthropicProvider per-model request shape", () => {
  const capture = () => {
    const box: { sent: any; headers: Headers } = { sent: null, headers: new Headers() };
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      box.sent = JSON.parse(String(init.body));
      box.headers = new Headers(init.headers);
      return sse([
        { event: "message_start", data: { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "x", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } } },
        { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } } },
        { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Checking funding first." } } },
        { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
        { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } } },
        { event: "message_stop", data: { type: "message_stop" } },
      ]);
    }) as unknown as typeof globalThis.fetch;
    return { box, fetch: fakeFetch };
  };

  test("Haiku 4.5: no effort, no adaptive thinking, basic web search, no fallbacks", async () => {
    const { box, fetch } = capture();
    const p = new AnthropicProvider({ apiKey: "k", model: "claude-haiku-4-5", effort: "high", fetch });
    expect(p.effort).toBeUndefined();
    await p.start("S", [], "q").step(TOOL_SPECS, hooks().h, { signal: new AbortController().signal });
    expect(box.sent.output_config).toBeUndefined();
    expect(box.sent.thinking).toBeUndefined();
    expect(box.sent.fallbacks).toBeUndefined();
    expect(box.sent.tools.at(-1)).toMatchObject({ type: "web_search_20250305", name: "web_search" });
  });

  test("thinking summaries stream to onReasoning; a base-URL override drops fallbacks", async () => {
    const { box, fetch } = capture();
    const p = new AnthropicProvider({ apiKey: "k", model: "claude-sonnet-5-5", effort: "low", baseURL: "https://proxy.local", fetch });
    const reasoning: string[] = [];
    await p.start("S", [], "q").step(TOOL_SPECS, { onText: () => {}, onReasoning: (d) => void reasoning.push(d) }, { signal: new AbortController().signal });
    expect(reasoning.join("")).toBe("Checking funding first.");
    expect(box.sent.output_config).toEqual({ effort: "low" });
    expect(box.sent.fallbacks).toBeUndefined();
  });
});

describe("OpenAICompatibleProvider", () => {
  test("parses streamed text and tool calls; no web search tool is sent", async () => {
    const bodies: any[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      expect(url).toBe("http://llm.local/v1/chat/completions");
      expect((init.headers as Record<string, string>).authorization).toBe("Bearer k");
      bodies.push(JSON.parse(String(init.body)));
      return sse([
        { data: { choices: [{ delta: { content: "Looking" } }] } },
        { data: { choices: [{ delta: { content: " up." } }] } },
        { data: { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "get_hl_markets", arguments: "{\"lim" } }] } }] } },
        { data: { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "it\":3}" } }] }, finish_reason: "tool_calls" }] } },
        { data: { choices: [], usage: { prompt_tokens: 50, completion_tokens: 7 } } },
        { data: "[DONE]" },
      ]);
    }) as unknown as typeof fetch;
    const p = new OpenAICompatibleProvider({ apiKey: "k", model: "m", baseURL: "http://llm.local/v1/", fetch: fakeFetch });
    const conv = p.start("SYS", [], "q");
    const { h, text } = hooks();
    const res = await conv.step(TOOL_SPECS, h, { signal: new AbortController().signal });
    expect(text.join("")).toBe("Looking up.");
    expect(res).toEqual({ stop: "tool_use", toolCalls: [{ id: "c1", name: "get_hl_markets", input: { limit: 3 } }], usage: { input_tokens: 50, output_tokens: 7 } });
    expect(bodies[0].tools.map((t: any) => t.function.name)).not.toContain("web_search");
    expect(bodies[0].messages[0]).toEqual({ role: "system", content: "SYS" });
    conv.addToolResults([{ id: "c1", name: "get_hl_markets", content: "[]", isError: false }]);
    await conv.step(TOOL_SPECS, h, { signal: new AbortController().signal, final: true });
    expect(bodies[1].tool_choice).toBe("none");
    expect(bodies[1].messages.at(-2)).toMatchObject({ role: "assistant", tool_calls: [{ id: "c1" }] });
    expect(bodies[1].messages.at(-1)).toEqual({ role: "tool", tool_call_id: "c1", content: "[]" });
  });

  test("HTTP errors throw without echoing the key", async () => {
    const fakeFetch = (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;
    const p = new OpenAICompatibleProvider({ apiKey: "secret-key", model: "m", baseURL: "http://x", fetch: fakeFetch });
    const err = await p.start("s", [], "q").step([], hooks().h, { signal: new AbortController().signal }).catch((e) => e as Error);
    expect(String(err)).toContain("HTTP 401");
    expect(String(err)).not.toContain("secret-key");
  });
});

describe("OpenAICompatibleProvider presets", () => {
  test("reasoning streams to onReasoning and is replayed on the assistant message when the preset needs it", async () => {
    const bodies: any[] = [];
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return sse([
        { data: { choices: [{ delta: { reasoning_content: "Need markets." } }] } },
        { data: { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "get_hl_markets", arguments: "{}" } }] }, finish_reason: "tool_calls" }] } },
        { data: "[DONE]" },
      ]);
    }) as unknown as typeof fetch;
    const p = new OpenAICompatibleProvider({
      id: "deepseek",
      label: "DeepSeek",
      apiKey: "k",
      model: "deepseek-v4-pro",
      baseURL: "https://api.deepseek.com",
      effort: "high",
      extraBody: { thinking: { type: "enabled" }, reasoning_effort: "high" },
      replayReasoning: true,
      fetch: fakeFetch,
    });
    expect(p.id).toBe("deepseek");
    const conv = p.start("S", [{ role: "user", content: "earlier q" }, { role: "assistant", content: "earlier a" }], "q");
    const reasoning: string[] = [];
    await conv.step(TOOL_SPECS, { onText: () => {}, onReasoning: (d) => void reasoning.push(d) }, { signal: new AbortController().signal });
    expect(reasoning).toEqual(["Need markets."]);
    expect(bodies[0]).toMatchObject({ thinking: { type: "enabled" }, reasoning_effort: "high", max_tokens: 16000 });
    // History folds into the opening user message (no reasoning-less assistant turns).
    expect(bodies[0].messages.map((m: any) => m.role)).toEqual(["system", "user"]);
    expect(bodies[0].messages[1].content).toContain("Analyst: earlier a");
    conv.addToolResults([{ id: "c1", name: "get_hl_markets", content: "[]", isError: false }]);
    await conv.step(TOOL_SPECS, hooks().h, { signal: new AbortController().signal });
    expect(bodies[1].messages.at(-2)).toMatchObject({ role: "assistant", reasoning_content: "Need markets." });
  });

  test("OpenAI uses max_completion_tokens and never replays reasoning", async () => {
    const bodies: any[] = [];
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return sse([{ data: { choices: [{ delta: { reasoning: "x", content: "ok" }, finish_reason: "stop" }] } }, { data: "[DONE]" }]);
    }) as unknown as typeof fetch;
    const p = new OpenAICompatibleProvider({ id: "openai", apiKey: "k", model: "gpt-6-luna", baseURL: "https://api.openai.com/v1", maxTokensField: "max_completion_tokens", extraBody: { reasoning_effort: "low" }, fetch: fakeFetch });
    const conv = p.start("S", [{ role: "user", content: "a" }, { role: "assistant", content: "b" }], "q");
    await conv.step([], hooks().h, { signal: new AbortController().signal });
    expect(bodies[0].max_completion_tokens).toBe(16000);
    expect(bodies[0].max_tokens).toBeUndefined();
    expect(bodies[0].reasoning_effort).toBe("low");
    expect(bodies[0].messages.map((m: any) => m.role)).toEqual(["system", "user", "assistant", "user"]);
  });
});

describe("tools", () => {
  const deps: ToolDeps = {
    marketstateLatest: () => ({ generated_at: "g", headline: "h" }),
    marketstateHistory: () => [{ date: "2026-08-30", data: { headline: "old" } }],
    sectors: async () => ({ sectors: [], rotations: [] }),
    metricsSummary: async (ids) => ids,
    series: async (id, from, buckets) => [{ id, from, buckets }],
    hlMarkets: async () => ({
      fetchedAt: "t",
      markets: ["BTC", "ETH", "SOL", "HYPE"].map((coin) => ({ coin, markPx: 1, oraclePx: 1, premium: 0, funding: 0, openInterestUsd: 1, dayNtlVlm: 1, dayChangePct: 0 })),
    }),
    engine: async (rest) =>
      rest.startsWith("decisions")
        ? { status: 200, json: { decisions: [{ id: "d1", strategy_id: "funding_skew", answers: {}, intents: [], verdicts: [], extra: "dropped", query: rest }] } }
        : rest === "configs"
          ? { status: 200, json: { strategies: [{ manifest: { id: "funding_skew", cadence: "5m" }, config: { enabled: true, venue: "paper" }, last_action: "hold" }] } }
          : { status: 200, json: { mode: "manual" } },
  };

  test("marketstate latest + dated", async () => {
    const latest = await runTool("get_marketstate", {}, deps);
    expect(JSON.parse(latest.content)).toEqual({ latest: { generated_at: "g", headline: "h" }, history: ["2026-08-30"] });
    const dated = await runTool("get_marketstate", { date: "2026-08-30" }, deps);
    expect(JSON.parse(dated.content)).toEqual({ headline: "old" });
    const missing = await runTool("get_marketstate", { date: "2026-01-01" }, deps);
    expect(missing.isError).toBe(true);
  });

  test("hl markets limit and coin filter; series default buckets; metrics default ids", async () => {
    expect(JSON.parse((await runTool("get_hl_markets", { limit: 2 }, deps)).content).markets.map((m: any) => m.coin)).toEqual(["BTC", "ETH"]);
    expect(JSON.parse((await runTool("get_hl_markets", { coins: ["hype"] }, deps)).content).markets.map((m: any) => m.coin)).toEqual(["HYPE"]);
    expect(JSON.parse((await runTool("get_series", { id: "hl.total_oi_usd" }, deps)).content).points[0].buckets).toBe(60);
    expect(JSON.parse((await runTool("get_metrics_summary", {}, deps)).content)).toContain("hl.total_oi_usd");
  });

  test("engine tools are compact and read-only", async () => {
    const st = await runTool("get_engine_strategies", {}, deps);
    expect(JSON.parse(st.content)).toEqual({ strategies: [expect.objectContaining({ id: "funding_skew", enabled: true, venue: "paper", last_action: "hold" })], governor: { mode: "manual" } });
    const dec = await runTool("get_engine_decisions", { limit: 3, strategy: "funding_skew" }, deps);
    const d = JSON.parse(dec.content).decisions[0];
    expect(d.extra).toBeUndefined();
    expect(TOOL_SPECS.some((t) => /approve|reject|kill|put|order/i.test(t.name))).toBe(false);
    expect((await runTool("get_engine_decisions", { strategy: "../kill" }, deps)).isError).toBe(true);
  });
});
