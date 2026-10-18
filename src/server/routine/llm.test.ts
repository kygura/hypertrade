import { describe, expect, test } from "bun:test";
import { z } from "zod";
import type { Conversation, LLMProvider, StepResult } from "../llm/provider.js";
import { callChain, envProviderFactory, MemoryLlmCache, parseChain, type ChainEntry } from "./llm.js";
import { DailyOutputSchema, pulseOutputSchema, toJsonSchema } from "./schema.js";

type Reply = { emit?: unknown; throws?: string };

/** Scripted provider: one reply per step. */
export class StubProvider implements LLMProvider {
  readonly id = "moonshot" as const;
  readonly webSearch = false;
  calls = 0;
  systems: string[] = [];
  users: string[] = [];
  constructor(
    readonly model: string,
    private readonly replies: Reply[],
    private readonly tokens = { input_tokens: 1000, output_tokens: 500 },
  ) {}
  start(system: string, _history: unknown[], question: string): Conversation {
    this.systems.push(system);
    this.users.push(question);
    const self = this;
    return {
      async step(): Promise<StepResult> {
        self.calls++;
        const r = self.replies.shift() ?? {};
        if (r.throws) throw new Error(r.throws);
        const toolCalls = r.emit === undefined ? [] : [{ id: "t", name: "emit", input: r.emit }];
        return { stop: toolCalls.length ? "tool_use" : "end", toolCalls, usage: self.tokens };
      },
      addToolResults() {},
    };
  }
}

const schema = z.object({ answer: z.string().min(1) });
const args = { system: "S", user: "U", schema, jsonSchema: toJsonSchema(schema), promptVersion: "t1" };
const entries = parseChain("moonshot:kimi-k3@high,deepseek:deepseek-v4-pro,openrouter:x/y").entries;
const deps = (providers: Record<string, LLMProvider | null>, maxUsd = 10) => ({
  entries,
  makeProvider: (e: ChainEntry) => providers[e.model] ?? null,
  cache: new MemoryLlmCache(),
  maxUsd,
  now: () => new Date("2026-10-18T00:00:00Z"),
});

describe("provider chain", () => {
  test("parses provider:model[@effort]; bad entries are reported, default when empty", () => {
    expect(entries.map((e) => [e.provider, e.model, e.effort])).toEqual([
      ["moonshot", "kimi-k3", "high"],
      ["deepseek", "deepseek-v4-pro", undefined],
      ["openrouter", "x/y", undefined],
    ]);
    const bad = parseChain("nope:model,moonshot:kimi@wild,moonshot:");
    expect(bad.entries).toEqual([]);
    expect(bad.errors).toHaveLength(3);
    expect(parseChain(undefined).entries.map((e) => e.raw)).toEqual(["anthropic:claude-opus-5-5@high", "moonshot:kimi-k3@high", "moonshot:kimi-k2.6"]);
  });

  test("falls through missing key, HTTP error and invalid output; stops at the first valid answer", async () => {
    const broken = new StubProvider("deepseek-v4-pro", [{ throws: "HTTP 503" }]);
    const invalid = new StubProvider("x/y", [{ emit: { answer: "" } }, { emit: { wrong: 1 } }]);
    const r1 = await callChain(deps({ "kimi-k3": null, "deepseek-v4-pro": broken, "x/y": invalid }), args);
    expect(r1.ok).toBe(false);
    expect(r1.attempts.map((a) => [a.entry, a.ok])).toEqual([
      ["moonshot:kimi-k3@high", false],
      ["deepseek:deepseek-v4-pro", false],
      ["openrouter:x/y", false],
    ]);
    expect(r1.attempts[0]!.error).toContain("no API key");
    expect(r1.attempts[1]!.error).toContain("HTTP 503");
    expect(r1.attempts[2]!.error).toContain("invalid output after retry");
    expect(invalid.calls).toBe(2); // completeStructured's one retry

    const good = new StubProvider("x/y", [{ emit: { answer: "ok" } }]);
    const r2 = await callChain(deps({ "deepseek-v4-pro": new StubProvider("deepseek-v4-pro", [{ throws: "boom" }]), "x/y": good }), args);
    expect(r2).toMatchObject({ ok: true, value: { answer: "ok" }, model: "x/y" });
  });

  test("the spend cap stops the chain instead of falling through", async () => {
    // An unpriced model is billed at the top row ($10/$50 per MTok): 100k in + 20k out ≈ $2.
    const pricey = new StubProvider("mystery-xl", [{ emit: { answer: "a" } }], { input_tokens: 100_000, output_tokens: 20_000 });
    const d = deps({ "kimi-k3": pricey, "deepseek-v4-pro": new StubProvider("deepseek-v4-pro", [{ emit: { answer: "b" } }]) }, 1);
    expect((await callChain(d, args)).ok).toBe(true);
    expect(d.cache.spentUsd()).toBeGreaterThan(1);
    const second = await callChain(d, args);
    expect(second).toMatchObject({ ok: false });
    expect(!second.ok && second.error).toContain("spend cap");
    expect(second.attempts).toHaveLength(1);
  });

  test("envProviderFactory builds a provider only when its key is set", () => {
    const e = entries[0]!;
    expect(envProviderFactory({})(e)).toBeNull();
    expect(envProviderFactory({ MOONSHOT_API_KEY: "k" })(e)?.model).toBe("kimi-k3");
  });
});

describe("emit schemas", () => {
  test("toJsonSchema mirrors zod: required, nullable, enums, nested objects", () => {
    const js = toJsonSchema(pulseOutputSchema(true)) as { properties: Record<string, any>; required: string[] };
    expect(js.required).toEqual(["regime_read", "htf_view", "new_setups", "cancel", "stand_aside_reason", "brief"]);
    expect(js.properties.htf_view.anyOf[1]).toEqual({ type: "null" });
    expect(js.properties.new_setups.items.properties.direction).toEqual({ type: "string", enum: ["long", "short"] });
    expect(js.properties.new_setups.items.additionalProperties).toBe(false);
    const daily = toJsonSchema(DailyOutputSchema) as { properties: Record<string, any> };
    expect(daily.properties.marketstate.properties.domains.items.properties.domain.enum).toEqual(["macro", "equities", "crypto", "tech", "geopolitics"]);
  });

  test("pulse schema: htf_view required when due, stand_aside_reason required when no setups", () => {
    const base = { regime_read: "r", htf_view: null, new_setups: [], cancel: [], stand_aside_reason: null, brief: "b" };
    expect(pulseOutputSchema(false).safeParse({ ...base, stand_aside_reason: "quiet" }).success).toBe(true);
    expect(pulseOutputSchema(false).safeParse(base).success).toBe(false);
    expect(pulseOutputSchema(true).safeParse({ ...base, stand_aside_reason: "quiet" }).success).toBe(false);
    expect(pulseOutputSchema(false, false).safeParse(base).success).toBe(true); // htf mode: no setups, no reason needed
  });
});
