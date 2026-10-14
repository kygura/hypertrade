import { describe, expect, test } from "bun:test";
import { z } from "zod";
import type { Conversation, LLMProvider, StepOptions, StepResult, ToolSpec } from "../llm/provider.js";
import { completeStructured, extractJson, intelProviderFactory, type LlmCacheStore, type LlmDeps } from "./llm.js";

type Reply = { text?: string; emit?: unknown } | "hang";

/** Scripted provider: one reply per step, records prompts, tools and step options. */
class FakeProvider implements LLMProvider {
  readonly id = "anthropic" as const;
  readonly webSearch = true;
  readonly model = "fake-model";
  prompts: string[] = [];
  tools: ToolSpec[][] = [];
  opts: StepOptions[] = [];
  constructor(private readonly replies: Reply[]) {}
  start(_system: string, _history: unknown[], question: string): Conversation {
    this.prompts.push(question);
    const self = this;
    return {
      async step(tools, hooks, opts): Promise<StepResult> {
        self.tools.push(tools);
        self.opts.push(opts);
        const r = self.replies.shift() ?? { text: "" };
        if (r === "hang") return new Promise(() => {}); // ignores the signal on purpose
        if (r.text) hooks.onText(r.text);
        const toolCalls = r.emit === undefined ? [] : [{ id: "t1", name: "emit", input: r.emit }];
        return { stop: toolCalls.length ? "tool_use" : "end", toolCalls, usage: { input_tokens: 10, output_tokens: 5 } };
      },
      addToolResults() {},
    };
  }
}

class MemCache implements LlmCacheStore {
  rows = new Map<string, unknown>();
  puts: Array<{ key: string; usage: unknown }> = [];
  calls: number;
  constructor(calls = 0) {
    this.calls = calls;
  }
  async cacheGet(key: string, v: string) {
    return this.rows.get(`${key}|${v}`) ?? null;
  }
  async cachePut(key: string, v: string, output: unknown, usage: unknown) {
    this.rows.set(`${key}|${v}`, output);
    this.puts.push({ key, usage });
  }
  async callsSince() {
    return this.calls + this.puts.length;
  }
}

const schema = z.object({ label: z.string().min(1), score: z.number() }).strict();
const jsonSchema: ToolSpec["input_schema"] = {
  type: "object",
  properties: { label: { type: "string" }, score: { type: "number" } },
  required: ["label", "score"],
  additionalProperties: false,
};

function run(provider: FakeProvider | null, opts: { cache?: MemCache; cacheKey?: string; dailyCap?: number; signal?: AbortSignal; deadlineMs?: number; webSearch?: boolean } = {}) {
  const cache = opts.cache ?? new MemCache();
  const deps: LlmDeps = { makeProvider: () => provider, cache, now: () => new Date("2026-10-13T12:00:00Z"), dailyCap: opts.dailyCap ?? 200 };
  return completeStructured({ tier: "cheap", system: "SYS", user: "USER", schema, jsonSchema, promptVersion: "v1", cacheKey: opts.cacheKey, webSearch: opts.webSearch, signal: opts.signal, deadlineMs: opts.deadlineMs, deps });
}

describe("completeStructured", () => {
  test("tool path: reads the emit input, caches it, web search off by default", async () => {
    const p = new FakeProvider([{ emit: { label: "a", score: 1 } }]);
    const cache = new MemCache();
    const r = await run(p, { cache, cacheKey: "k1" });
    expect(r).toMatchObject({ ok: true, value: { label: "a", score: 1 }, cached: false });
    expect(r.trace).toMatchObject({ promptVersion: "v1", tier: "cheap", model: "fake-model", inputs: { system: "SYS", user: "USER" }, attempts: 1, usage: { input_tokens: 10, output_tokens: 5 } });
    expect(p.tools[0]!.map((t) => t.name)).toEqual(["emit"]);
    expect(p.tools[0]![0]!.input_schema).toBe(jsonSchema);
    expect(p.opts[0]!.webSearch).toBe(false);
    expect(cache.puts).toEqual([{ key: "k1", usage: { input_tokens: 10, output_tokens: 5, searches: 0 } }]);
  });

  test("webSearch: true is passed through", async () => {
    const p = new FakeProvider([{ emit: { label: "a", score: 1 } }]);
    await run(p, { webSearch: true });
    expect(p.opts[0]!.webSearch).toBe(true);
  });

  test("JSON-block fallback; uncached calls still count under a nocache key", async () => {
    const p = new FakeProvider([{ text: 'Here:\n```json\n{"label":"b","score":2}\n```' }]);
    const cache = new MemCache();
    const r = await run(p, { cache });
    expect(r).toMatchObject({ ok: true, value: { label: "b", score: 2 } });
    expect(cache.puts[0]!.key).toMatch(/^nocache:[0-9a-f-]{36}$/);
  });

  test("retry with the zod error, then success", async () => {
    const p = new FakeProvider([{ emit: { label: "", score: "x" } }, { emit: { label: "c", score: 3 } }]);
    const r = await run(p);
    expect(r).toMatchObject({ ok: true, value: { label: "c", score: 3 } });
    expect(r.trace.attempts).toBe(2);
    expect(r.trace.usage).toEqual({ input_tokens: 20, output_tokens: 10 });
    expect(p.prompts[1]).toContain("USER");
    expect(p.prompts[1]).toContain("label:");
    expect(p.prompts[1]).toContain("score:");
  });

  test("retry then fail closed; nothing cached", async () => {
    const p = new FakeProvider([{ text: "no json here" }, { emit: { label: "d" } }]);
    const cache = new MemCache();
    const r = await run(p, { cache, cacheKey: "k" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("score");
    expect(r.trace.attempts).toBe(2);
    expect(p.prompts[1]).toContain("no `emit` call");
    expect(cache.puts.map((p) => p.key.startsWith("nocache:"))).toEqual([true]); // nothing cached under the key; the spend is billed in a row of its own
    expect(cache.rows.has("k|v1")).toBe(false);
  });

  test("cache hit: no provider call", async () => {
    const cache = new MemCache();
    cache.rows.set("k|v1", { label: "cached", score: 9 });
    let built = 0;
    const deps: LlmDeps = { makeProvider: () => (built++, null), cache, now: () => new Date(), dailyCap: 0 };
    const r = await completeStructured({ tier: "strong", system: "S", user: "U", schema, jsonSchema, promptVersion: "v1", cacheKey: "k", deps });
    expect(r).toMatchObject({ ok: true, value: { label: "cached", score: 9 }, cached: true });
    expect(r.trace.model).toBeNull();
    expect(built).toBe(0);
  });

  test("cap reached: fail closed before calling the provider", async () => {
    const p = new FakeProvider([{ emit: { label: "a", score: 1 } }]);
    const r = await run(p, { cache: new MemCache(200) });
    expect(r).toMatchObject({ ok: false, error: "LLM cap reached" });
    expect(p.prompts).toEqual([]);
  });

  test("no provider", async () => {
    expect(await run(null)).toMatchObject({ ok: false, error: "llm not configured" });
  });

  test("deadline and abort return instead of hanging", async () => {
    expect(await run(new FakeProvider(["hang"]), { deadlineMs: 20 })).toMatchObject({ ok: false, error: "deadline exceeded" });
    const ctl = new AbortController();
    const pending = run(new FakeProvider(["hang"]), { signal: ctl.signal });
    ctl.abort();
    expect(await pending).toMatchObject({ ok: false, error: "aborted" });
  });

  test("a throwing provider fails closed", async () => {
    const p = new FakeProvider([]);
    p.start = () => {
      throw new Error("boom");
    };
    expect(await run(p)).toMatchObject({ ok: false, error: "boom" });
  });
});

describe("extractJson", () => {
  test("fenced block, bare object, nothing", () => {
    expect(extractJson('x ```json\n{"a":1}\n``` y')).toEqual({ a: 1 });
    expect(extractJson('sure: {"a":{"b":2}} done')).toEqual({ a: { b: 2 } });
    expect(extractJson("no json")).toBeUndefined();
  });
});

describe("intelProviderFactory", () => {
  test("strong → pm model, cheap → specialist model", () => {
    const f = intelProviderFactory({ ANTHROPIC_API_KEY: "k", DESK_ANALYST_MODEL: "claude-opus-5-5", DESK_SCOUT_MODEL: "claude-sonnet-5-5" });
    expect(f("strong")!.model).toBe("claude-opus-5-5");
    expect(f("cheap")!.model).toBe("claude-sonnet-5-5");
    expect(intelProviderFactory({})("cheap")).toBeNull();
  });
});
