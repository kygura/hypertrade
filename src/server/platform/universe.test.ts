import { describe, expect, test } from "bun:test";
import { migrate } from "../../../db/migrate.js";
import type { LlmCacheStore, LlmDeps } from "../intel/llm.js";
import type { Conversation, LLMProvider, StepResult } from "../llm/provider.js";
import { newPglite, pgliteDb } from "../testing/pglite.js";
import { MemoryPlatformStore } from "./store-memory.js";
import { PgPlatformStore } from "./store-pg.js";
import { ensureSectors, parseUniverseSpec, sectorAnswerSchema, selectUniverse } from "./universe.js";

const ctxs = [["BTC", 9], ["ETH", 8], ["SOL", 7], ["FET", 6], ["ZEC", 5], ["DOGE", 4], ["HYPE", 3]].map(([coin, dayNtlVlm]) => ({ coin: coin as string, dayNtlVlm: dayNtlVlm as number }));
const tags = { FET: ["AI"], ZEC: ["Privacy"], HYPE: ["Perp DEX", "L1"], SOL: ["L1"], DOGE: ["Meme"] };
const names = (o: Parameters<typeof selectUniverse>[1]) => selectUniverse([...ctxs].reverse(), o).map((c) => c.coin);

describe("selectUniverse", () => {
  test("nothing -> all, liquid first", () => expect(names({})).toHaveLength(7));
  test("top", () => expect(names({ top: 3 })).toEqual(["BTC", "ETH", "SOL"]));
  test("sectors alone", () => expect(names({ sectors: ["L1"], tags })).toEqual(["SOL", "HYPE"]));
  test("top intersects sectors", () => expect(names({ top: 4, sectors: ["L1", "AI"], tags })).toEqual(["SOL", "FET"]));
  test("mine alone is only mine", () => expect(names({ mine: ["ZEC", "XXX"] })).toEqual(["ZEC"]));
  test("mine unions with filters", () => expect(names({ top: 2, mine: ["HYPE"] })).toEqual(["BTC", "ETH", "HYPE"]));
  test("untagged coins never match a sector filter", () => expect(names({ sectors: ["AI"], tags: {} })).toEqual([]));
});

test("parseUniverseSpec", () => {
  expect(parseUniverseSpec("top:30")).toEqual({ top: 30 });
  expect(parseUniverseSpec("sectors:AI,Perp DEX;mine")).toMatchObject({ sectors: ["AI", "Perp DEX"] });
  expect(() => parseUniverseSpec("sectors:Pizza")).toThrow();
  expect(() => parseUniverseSpec("nope")).toThrow();
  expect(() => parseUniverseSpec(";")).toThrow();
  expect(() => parseUniverseSpec("sectors:AI;sectors:L1")).toThrow(/duplicate/);
  expect(() => parseUniverseSpec("sectors:Pizza")).toThrow(/^unknown sector "Pizza"[^\n]*$/);
});

test("sector answers reject unknown sectors and extra keys", () => {
  expect(sectorAnswerSchema.safeParse({ tags: [{ coin: "FET", sectors: ["AI"] }] }).success).toBe(true);
  expect(sectorAnswerSchema.safeParse({ tags: [{ coin: "FET", sectors: ["Pizza"] }] }).success).toBe(false);
  expect(sectorAnswerSchema.safeParse({ tags: [{ coin: "FET", sectors: [] }] }).success).toBe(false);
});

/** Scripted LLM: one emit payload per call. */
function fakeLlm(emits: unknown[]) {
  const prompts: string[] = [];
  const p: LLMProvider = {
    id: "anthropic", webSearch: false, model: "fake",
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
  return { prompts, deps: { makeProvider: () => p, cache, now: () => new Date(), dailyCap: 100 } as LlmDeps };
}

describe("ensureSectors", () => {
  test("tags only untagged coins, in one call, and caches", async () => {
    const store = new MemoryPlatformStore();
    await store.saveSectors([{ coin: "BTC", sectors: ["L1"], taggedAt: "2026-01-01T00:00:00.000Z" }]);
    const llm = fakeLlm([{ tags: [{ coin: "FET", sectors: ["AI"] }, { coin: "NOPE", sectors: ["AI"] }] }]);
    const out = await ensureSectors(["BTC", "FET"], store, async () => llm.deps);
    expect(out).toEqual({ BTC: ["L1"], FET: ["AI"] });
    expect(llm.prompts).toHaveLength(1);
    expect(llm.prompts[0]).toContain("FET");
    expect(llm.prompts[0]).not.toContain("Coins: BTC");
    await ensureSectors(["BTC", "FET"], store, async () => { throw new Error("no llm needed"); });
    expect((await store.listSectors()).map((t) => t.coin)).toEqual(["BTC", "FET"]);
  });

  test("unknown sector twice -> coin stays untagged, no throw, not re-asked", async () => {
    const store = new MemoryPlatformStore();
    const bad = { tags: [{ coin: "BADC", sectors: ["Pizza"] }] };
    const llm = fakeLlm([bad, bad, bad, bad]);
    expect(await ensureSectors(["BADC"], store, async () => llm.deps)).toEqual({});
    expect(await store.listSectors()).toEqual([]);
    const asked = llm.prompts.length;
    await ensureSectors(["BADC"], store, async () => llm.deps);
    expect(llm.prompts).toHaveLength(asked);
  });

  test("a coin the LLM leaves out is stored as Other and never re-asked", async () => {
    const store = new MemoryPlatformStore();
    const llm = fakeLlm([{ tags: [{ coin: "KEPT", sectors: ["AI"] }] }]);
    const out = await ensureSectors(["KEPT", "DROPPED"], store, async () => llm.deps);
    expect(out).toEqual({ KEPT: ["AI"], DROPPED: ["Other"] });
    await ensureSectors(["KEPT", "DROPPED"], store, async () => llm.deps);
    expect(llm.prompts).toHaveLength(1);
  });

  test("llm construction failure leaves coins untagged", async () => {
    expect(await ensureSectors(["DOWNC"], new MemoryPlatformStore(), async () => { throw new Error("boom"); })).toEqual({});
  });
});

test("sector store: memory and PGlite agree", async () => {
  const db = pgliteDb(newPglite());
  await migrate(db, () => {});
  const rows = [{ coin: "ZEC", sectors: ["Privacy"] as const, taggedAt: "2026-02-01T00:00:00.000Z" }, { coin: "FET", sectors: ["AI", "Infra"] as const, taggedAt: "2026-02-01T00:00:00.000Z" }].map((r) => ({ ...r, sectors: [...r.sectors] }));
  const out: unknown[] = [];
  for (const s of [new MemoryPlatformStore(), new PgPlatformStore(db)]) {
    await s.saveSectors(rows);
    await s.saveSectors([{ ...rows[0]!, sectors: ["Privacy", "L1"] }]);
    out.push(await s.listSectors());
  }
  expect(out[1]).toEqual(out[0]);
  expect((out[0] as { coin: string }[]).map((t) => t.coin)).toEqual(["FET", "ZEC"]);
});
