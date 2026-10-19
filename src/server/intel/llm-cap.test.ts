import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { EmitProvider, llmDeps } from "./fixtures/emit-provider.js";
import { completeStructured, usageCost, type LlmDeps } from "./llm.js";
import { MemoryIntelStore } from "./store.js";

// Dollar cap (docs/SPEC.md § Flow F0.7): stored usage × per-model price, checked beside the call cap.

const NOW = new Date("2026-10-13T12:00:00Z");
const schema = z.object({ ok: z.boolean() });
const jsonSchema = { type: "object" as const, properties: { ok: { type: "boolean" } }, required: ["ok"] };

function setup(dailyUsd?: number, clock = () => NOW) {
  const store = new MemoryIntelStore(clock);
  const provider = new EmitProvider(() => ({ ok: true }));
  const deps: LlmDeps = { ...llmDeps(provider, store, () => NOW), ...(dailyUsd === undefined ? {} : { dailyUsd }) };
  const call = () => completeStructured({ tier: "cheap", system: "S", user: "U", schema, jsonSchema, promptVersion: "v1", deps });
  return { store, provider, call };
}

describe("usageCost", () => {
  test("known model at its rate, unknown or missing model at the priciest row", () => {
    expect(usageCost({ input_tokens: 1e6, output_tokens: 1e6, model: "claude-haiku-4-5" })).toBeCloseTo(6, 9);
    expect(usageCost({ input_tokens: 1e6, output_tokens: 0, model: "gpt-x" })).toBeCloseTo(10, 9);
    expect(usageCost({ input_tokens: 0, output_tokens: 1e6 })).toBeCloseTo(50, 9);
    expect(usageCost(null)).toBe(0);
  });
    expect(usageCost({ input_tokens: 0, output_tokens: 0, searches: 3, model: "claude-opus-5-5" })).toBeCloseTo(0.03, 9); // web search fee
});

describe("daily dollar cap", () => {
  test("under the cap the call runs and its usage is stored with the model", async () => {
    const { store, call } = setup(0.5);
    expect((await call()).ok).toBe(true);
    expect(await store.usageSince(new Date(0))).toEqual([{ input_tokens: 1, output_tokens: 1, searches: 0, model: "scripted" }]);
  });

  test("over the cap: fail closed before calling the provider, message shows spent / limit", async () => {
    const { store, provider, call } = setup(0.5);
    await store.cachePut("old", "v0", {}, { input_tokens: 100_000, output_tokens: 20_000 }, "claude-opus-5-5"); // $0.40 + $0.40
    const r = await call();
    expect(r).toMatchObject({ ok: false, error: "LLM cap reached ($0.80 / $0.50)" });
    expect(provider.prompts).toHaveLength(0);
  });

  test("defaults to $2.00; unknown model priced at the priciest rate", async () => {
    const { store, call } = setup();
    await store.cachePut("old", "v0", {}, { input_tokens: 200_000, output_tokens: 0 }); // no model → $10/MTok → $2.00
    expect(await call()).toMatchObject({ ok: false, error: "LLM cap reached ($2.00 / $2.00)" });
  });

  test("spend from before the UTC day does not count", async () => {
    let t = new Date("2026-10-12T23:00:00Z");
    const { store, call } = setup(0.5, () => t);
    await store.cachePut("old", "v0", {}, { input_tokens: 1e6, output_tokens: 0 }, "claude-opus-5-5");
    t = NOW;
    expect((await call()).ok).toBe(true);
  });

  test("the call cap still trips on its own", async () => {
    const store = new MemoryIntelStore(() => NOW);
    const deps = { ...llmDeps(new EmitProvider(() => ({ ok: true })), store, () => NOW), dailyCap: 0 };
    expect(await completeStructured({ tier: "cheap", system: "S", user: "U", schema, jsonSchema, promptVersion: "v1", deps })).toMatchObject({ ok: false, error: "LLM cap reached" });
  });
});
