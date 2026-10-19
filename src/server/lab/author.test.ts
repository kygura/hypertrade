import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LlmCacheStore, LlmDeps } from "../intel/llm.js";
import type { Conversation, LLMProvider, StepResult } from "../llm/provider.js";
import { UpstreamError } from "../mcp/types.js";
import { authorRules } from "./author.js";
import { synthetic } from "./engine/testkit.js";
import { createLabService } from "./service.js";
import { fileStore, memoryStore } from "./store.js";
import type { LabProvider, MetricDef } from "./types.js";

const base = synthetic({ seed: 1, drift: 0.012 });
const metric = (key: string, over: Partial<MetricDef> = {}): MetricDef => ({
  id: `syn:${key}`,
  provider: "syn",
  key,
  name: key,
  category: "onchain",
  scope: "asset",
  description: key,
  lagDays: 0,
  ...over,
});
const provider: LabProvider = {
  id: "syn",
  name: "Synthetic",
  notes: "",
  metrics: () => [metric("a"), metric("b"), metric("lvl", { stationary: false })],
  fetch: async () => ({ t: [], v: [] }),
};

const good = { asset: "SYN", direction: "long", horizonDays: 2, conditions: [{ feature: "syn:a|z|30", op: "<", threshold: -1 }] };
const unknownMetric = { ...good, conditions: [{ feature: "syn:nope|z|30", op: "<", threshold: -1 }] };

/** Scripted LLM: one recorded `emit` payload per step; prompts kept for the repair assertion. */
function fakeLlm(emits: unknown[]) {
  const prompts: string[] = [];
  const p: LLMProvider = {
    id: "anthropic",
    webSearch: false,
    model: "fake",
    start(_s, _h, question): Conversation {
      prompts.push(question);
      return {
        async step(): Promise<StepResult> {
          return { stop: "tool_use", toolCalls: [{ id: "t", name: "emit", input: emits.shift() }], usage: { input_tokens: 1, output_tokens: 1 } };
        },
        addToolResults() {},
      };
    },
  };
  const cache: LlmCacheStore = { cacheGet: async () => null, cachePut: async () => {}, callsSince: async () => 0 };
  const llm: LlmDeps = { makeProvider: () => p, cache, now: () => new Date(), dailyCap: 100 };
  return { llm, prompts };
}

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

function kit(emits: unknown[], store = memoryStore()) {
  const { llm } = fakeLlm(emits);
  const service = createLabService({
    store,
    providers: [provider],
    llm,
    async loadDataset(cfg) {
      const metrics = Object.fromEntries(cfg.metrics.filter((m) => base.metrics[m]).map((m) => [m, base.metrics[m]!]));
      return { dataset: { ...base, asset: cfg.asset, metrics }, warnings: [] };
    },
  });
  return { service, store };
}

describe("authorRules", () => {
  const deps = (emits: unknown[]) => ({ llm: fakeLlm(emits).llm, metrics: provider.metrics() });

  test("returns validated candidates, merging equal rules", async () => {
    const r = await authorRules({ intent: "buy when a is low" }, deps([{ candidates: [good, { ...good }] }]));
    expect(r.ok && r.rules).toEqual([good] as never);
  });

  test("an unknown feature id is repaired in one round", async () => {
    const f = fakeLlm([{ candidates: [unknownMetric] }, { candidates: [good] }]);
    const r = await authorRules({ intent: "x" }, { llm: f.llm, metrics: provider.metrics() });
    expect(r.ok && r.rules).toEqual([good] as never);
    expect(f.prompts).toHaveLength(2);
    expect(f.prompts[1]).toContain("unknown metric syn:nope");
  });

  test("an unknown feature id still failing after the repair round fails closed", async () => {
    const r = await authorRules({ intent: "x" }, deps([{ candidates: [unknownMetric] }, { candidates: [unknownMetric] }]));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain("unknown metric syn:nope");
  });

  test("rejects raw on a trending level, a wrong asset and a wrong direction", async () => {
    const raw = { ...good, conditions: [{ feature: "syn:lvl|raw|0", op: "<", threshold: 1 }] };
    const cases: Array<{ bad: unknown; input: { asset?: string; direction?: "long" | "short" } }> = [
      { bad: raw, input: {} },
      { bad: { ...good, asset: "ETH" }, input: { asset: "SYN" } },
      { bad: { ...good, direction: "short" }, input: { direction: "long" } },
    ];
    for (const { bad, input } of cases) {
      const r = await authorRules({ intent: "x", ...input }, deps([{ candidates: [bad] }, { candidates: [bad] }]));
      expect(r.ok).toBe(false);
    }
  });
});

describe("lab_author_rule (service)", () => {
  test("every candidate is a trial, the catalogue stays empty", async () => {
    const other = { ...good, conditions: [{ feature: "syn:b|z|30", op: ">=", threshold: 1 }] };
    const { service, store } = kit([{ candidates: [good, other] }, { candidates: [good] }]);
    const first = await service.authorRule({ intent: "idea one" });
    expect(first.candidates.map((c) => c.idea)).toEqual([{ n: 1, of: 2 }, { n: 2, of: 2 }]);
    expect(first.candidates[0]!.evaluation?.verdict).toBeDefined();
    expect(first.candidates[0]!.text).toContain("syn:a z(30) < -1");
    const second = await service.authorRule({ intent: "idea two" });
    expect(second.trialCount).toBe(3);
    expect(await store.listCatalogue()).toEqual([]);
    expect((await store.listTrials()).map((t) => [t.n, t.intent])).toEqual([[1, "idea one"], [2, "idea one"], [3, "idea two"]]);
  });

  test("a failed authoring records nothing and surfaces as an upstream error", async () => {
    const { service, store } = kit([{ candidates: [unknownMetric] }, { candidates: [unknownMetric] }]);
    await expect(service.authorRule({ intent: "x" })).rejects.toBeInstanceOf(UpstreamError);
    expect(await store.listTrials()).toEqual([]);
  });

  test("catalogue list shows the first idea number of a saved rule; the counter survives a reload", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lab-author-"));
    dirs.push(dir);
    const path = join(dir, "lab.json");
    const a = kit([{ candidates: [good] }], fileStore(path));
    const { candidates } = await a.service.authorRule({ intent: "x" });
    await a.service.catalogueSave({ rule: candidates[0]!.rule, name: "A low" });
    // A fresh store over the same file: the log is still there and numbering continues.
    const b = kit([{ candidates: [good] }], fileStore(path));
    expect((await b.service.catalogueList({ live: false })).entries[0]!.idea).toEqual({ n: 1, of: 1 });
    expect((await b.service.authorRule({ intent: "again" })).candidates[0]!.idea).toEqual({ n: 2, of: 2 });
    expect((await b.service.catalogueList({ live: false })).entries[0]!.idea).toEqual({ n: 1, of: 2 });
  });
});
