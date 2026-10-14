import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { AssetDetailResponseSchema, HeatmapResponseSchema, type FlowFlag, type ResearchResult } from "../../../shared/intel.js";
import type { Citation, Conversation, LLMProvider, StepResult } from "../../llm/provider.js";
import { llmDeps } from "../../intel/fixtures/emit-provider.js";
import { exposureOf, position } from "../../intel/fixtures/mapper-deps.js";
import { autoResearch, RESEARCH_DEADLINE_MS } from "../../intel/research.js";
import { MemoryIntelStore } from "../../intel/store.js";
import { createIntelRoutes, type IntelDeps } from "./index.js";

// Route + automatic-stage tests, no network: a scripted provider that fires the hooks the Anthropic provider does.

const NOW = new Date("2026-10-14T12:00:00Z");
const URL_A = "https://news.example.com/jito-exploit";
const CITES: Citation[] = [{ url: URL_A, title: null, cited_text: "Attackers drained $12M from the Jito restaking pool on Tuesday" }];
const FOUND = { explanation: "", evidence: [{ claim: "Attackers drained $12M from the Jito pool", url: URL_A, ts: null, type: "observed" }], confidence: "medium", openQuestions: [] };

class Provider implements LLMProvider {
  readonly id = "anthropic" as const;
  readonly model = "claude-opus-5-5";
  readonly webSearch = true;
  prompts: string[] = [];
  start(_system: string, _history: unknown[], question: string): Conversation {
    this.prompts.push(question);
    return {
      async step(_tools, hooks): Promise<StepResult> {
        hooks.onServerToolCall?.({ id: "s0", name: "web_search", input: {} });
        hooks.onSearchResults?.([{ url: URL_A, title: "Jito exploit drains $12M" }]);
        for (const c of CITES) hooks.onCitation?.(c);
        return { stop: "tool_use", toolCalls: [{ id: "t1", name: "emit", input: FOUND }], usage: { input_tokens: 1000, output_tokens: 500 } };
      },
      addToolResults() {},
    };
  }
}

const flagOf = (asset: string, name = "crowded_long"): FlowFlag => ({ id: `detector:${name}:${asset}:24h:x`, asset, kind: "detector", name, window: "24h", numbers: { oi_z: 2.4 }, score: 2.4, degraded: false, ts: "2026-10-14T11:00:00.000Z", researchId: null });

function setup(env: Record<string, string> = {}, dailyUsd?: number) {
  const store = new MemoryIntelStore(() => NOW);
  const provider = new Provider();
  const llm = { ...llmDeps(provider, store, () => NOW), dailyUsd };
  const deps = {
    store,
    env: { DESK_WATCHLIST: "", ...env },
    exposure: async () => exposureOf([position("SOL", "long", 10_000)]),
    watched: async () => [],
    ctxs: async () => [],
    candles1h: async () => [],
    observations: async () => [],
    funding: async () => [],
    ingestHealth: async () => [],
    llm,
    thresholds: { minZ: 2, topK: 5, pushMateriality: 0.35, digestMateriality: 0.1 },
    now: () => NOW,
  } as unknown as IntelDeps;
  const app = new Hono().basePath("/api").route("/intel", createIntelRoutes(deps));
  const call = async (path: string, body?: unknown) => {
    const res = await app.request(`/api/intel${path}`, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  return { store, provider, llm, deps, call };
}

type Setup = ReturnType<typeof setup>;
const done = (over: Partial<ResearchResult> = {}) => ({ trigger: "manual" as const, asset: "SOL", question: "q?", status: "found" as const, explanation: "x", evidence: [], confidence: "low" as const, openQuestions: [], searches: 1, costUsd: 0.1, model: "m", ...over });

/** A stored detector flag with its flow alert, as flowAlerts writes them. */
async function seedFlag(store: MemoryIntelStore, flag: FlowFlag, materiality: number) {
  const [event] = await store.upsertEvents([
    { key: `flow:${flag.id}`, type: "data", title: `${flag.name} ${flag.asset}`, summary: null, entities: [flag.asset], assets: [flag.asset], magnitude: "med", sources: [{ label: "flow" }], origin: "flow", firstSeen: flag.ts, scheduledAt: null, catalyst: null, tag: "observed", flag },
  ]);
  await store.insertAlert({
    kind: "flow", ref: event!.id, window: null, asset: flag.asset, title: event!.title, eventType: flag.name, line: { tag: "observed", text: "t", source: { label: "flow" }, ts: flag.ts },
    path: [], edgeType: null, hops: 0, pathWeight: 1, sources: [{ label: "flow" }], materiality, pricedIn: null, route: "batch",
  });
}
const newsAlert = (store: MemoryIntelStore, asset: string) =>
  store.insertAlert({
    kind: "mapper", ref: `c-${asset}`, window: null, asset, title: "news", eventType: "exploit", line: { tag: "hypothesis", text: "t" }, path: [], edgeType: null, hops: 0, pathWeight: 1,
    sources: [{ label: "news", url: "https://news.example.net/a" }], materiality: 0.5, pricedIn: null, route: "batch",
  });

describe("POST /research", () => {
  test("200 found: manual trigger, flag asset and id stored, then GET lists it with usedToday", async () => {
    const { store, call } = setup();
    const flag = flagOf("SOL");
    await seedFlag(store, flag, 0.5);
    const { status, body } = await call("/research", { question: "Why did SOL move?", flagId: flag.id });
    expect(status).toBe(200);
    expect(body).toMatchObject({ status: "found", trigger: "manual", flagId: flag.id, asset: "SOL" });
    const list = await call("/research?limit=5");
    expect(list.body).toMatchObject({ usedToday: 1, limit: 10, items: [{ id: body.id }] });
  });

  test("400 for a bad body, 404 for an unknown flag", async () => {
    const { call, provider } = setup();
    expect((await call("/research", { question: "hi" })).status).toBe(400);
    expect((await call("/research", { question: "Why did SOL move?", asset: "not an asset!" })).status).toBe(400);
    expect((await call("/research", { question: "x".repeat(501) })).status).toBe(400);
    expect((await call("/research", { question: "Why did SOL move?", flagId: "nope" })).status).toBe(404);
    expect(provider.prompts).toHaveLength(0);
  });

  test("409 while a run is in flight", async () => {
    const { store, call, provider } = setup();
    await store.acquireResearch({ ...done({ status: "running" }) }, 60_000);
    const { status } = await call("/research", { question: "Why did SOL move?" });
    expect(status).toBe(409);
    expect(provider.prompts).toHaveLength(0);
  });

  test("429 once INTEL_RESEARCH_DAILY manual runs happened since UTC midnight", async () => {
    const { store, call, provider } = setup({ INTEL_RESEARCH_DAILY: "2" });
    await store.insertResearch(done());
    await store.insertResearch(done({ status: "no_cause" }));
    await store.insertResearch(done({ trigger: "flag" })); // automatic runs have their own budget
    const { status } = await call("/research", { question: "Why did SOL move?" });
    expect(status).toBe(429);
    expect(provider.prompts).toHaveLength(0);
  });

  test("over the dollar cap: 200 with status capped", async () => {
    const { call, provider } = setup({}, 0);
    const { status, body } = await call("/research", { question: "Why did SOL move?" });
    expect(status).toBe(200);
    expect(body.status).toBe("capped");
    expect(provider.prompts).toHaveLength(0);
  });
});

describe("research joins", () => {
  test("heatmap and flows carry researchId read-time; the stored flag stays untouched", async () => {
    const { store, call } = setup();
    const flag = flagOf("SOL");
    await seedFlag(store, flag, 0.5);
    const r = await store.insertResearch(done({ flagId: flag.id }));
    await store.insertResearch(done({ flagId: "failed-one", status: "failed" }));
    const flows = (await call("/flows")).body as { flags: FlowFlag[] };
    expect(flows.flags).toMatchObject([{ id: flag.id, researchId: r.id }]);
    expect((await store.listEvents({ type: "data", limit: 5 }))[0]!.flag!.researchId).toBeNull();
  });

  test("heatmap flags carry researchId once a result exists for the flag", async () => {
    const { store, call } = setup();
    // 15-min SOL snapshots over 5 days, flat then a jump and a depth collapse in the last 45 min (as in flow.test.ts).
    const rows = Array.from({ length: 5 * 96 + 1 }, (_, k) => {
      const i = 5 * 96 - k;
      const jitter = 1 + 0.002 * (Math.abs(Math.sin(i * 12.9898) * 43758.5453 % 1) - 0.5);
      return { asset: "SOL", ts: new Date(NOW.getTime() - i * 900_000).toISOString(), price: i <= 3 ? 110 : 100 * jitter, vol24h: null, funding: 1e-5, oiUsd: null, premium: null, basis: null, depthBid1: null, depthAsk1: null, depthBid2: i === 0 ? 1.5e5 : 5e5, depthAsk2: i === 0 ? 1.5e5 : 5e5, spreadBps: null };
    });
    await store.insertSnapshots(rows);
    const before = HeatmapResponseSchema.parse((await call("/heatmap?window=1h")).body);
    expect(before.flags.length).toBeGreaterThan(0);
    expect(before.flags.every((f) => f.researchId === null)).toBe(true);
    const target = before.flags[0]!;
    const r = await store.insertResearch(done({ flagId: target.id }));
    const after = HeatmapResponseSchema.parse((await call("/heatmap?window=1h")).body);
    expect(after.flags.find((f) => f.id === target.id)?.researchId).toBe(r.id);
    expect(after.flags.filter((f) => f.id !== target.id).every((f) => f.researchId === null)).toBe(true);
  });

  test("/asset/:coin lists research results as events in ascending order", async () => {
    const { store, call } = setup();
    await store.upsertEvents([
      { key: "cat:1", type: "upgrade", title: "SOL upgrade", summary: null, entities: ["SOL"], assets: ["SOL"], magnitude: "med", sources: [{ label: "manual" }], origin: "manual", firstSeen: NOW.toISOString(), scheduledAt: new Date(NOW.getTime() + 3_600_000).toISOString(), catalyst: null, tag: "hypothesis" },
    ]);
    const r = await store.insertResearch(done({ question: "Why did SOL move?" }));
    await store.insertResearch(done({ asset: "ETH" }));
    const a = AssetDetailResponseSchema.parse((await call("/asset/SOL?days=2")).body);
    expect(a.events.map((e) => e.kind)).toEqual(["research", "catalyst"]);
    expect(a.events[0]).toMatchObject({ title: "Why did SOL move?", tag: "observed", research: { id: r.id } });
  });
});

describe("autoResearch", () => {
  const run = (s: Setup, env: Record<string, string> = {}, left: () => number = () => 200_000) =>
    autoResearch({ store: s.store, llm: s.llm, exposure: s.deps.exposure, now: () => NOW, pushMateriality: 0.35, env }, left);

  test("runs the highest unexplained flags; skips news-covered, researched and sub-threshold ones", async () => {
    const s = setup();
    const [eth, btc, sol, hype, avax] = ["ETH", "BTC", "SOL", "HYPE", "AVAX"].map((a) => flagOf(a));
    await seedFlag(s.store, eth!, 0.5);
    await seedFlag(s.store, btc!, 0.8);
    await seedFlag(s.store, sol!, 0.9); // highest, but a news alert covers SOL
    await seedFlag(s.store, hype!, 0.2); // below the push threshold
    await seedFlag(s.store, avax!, 0.6); // already explained
    await newsAlert(s.store, "SOL");
    await s.store.insertResearch(done({ trigger: "flag", flagId: avax!.id, asset: "AVAX" }));
    expect(await run(s, { INTEL_RESEARCH_AUTO_DAILY: "5" })).toBe(2);
    expect(s.provider.prompts.map((p) => /Why did (\w+)/.exec(p)![1])).toEqual(["BTC", "ETH"]);
    expect(s.store.research.filter((r) => r.trigger === "flag" && r.status !== "running").map((r) => r.flagId)).toEqual([avax!.id, btc!.id, eth!.id]);
    expect(await run(s, { INTEL_RESEARCH_AUTO_DAILY: "5" })).toBe(0); // everything left is explained now
  });

  test("respects INTEL_RESEARCH_AUTO_DAILY (default 3) per UTC day, counting earlier flag runs", async () => {
    const s = setup();
    for (const a of ["ETH", "BTC", "AVAX", "DOGE"]) await seedFlag(s.store, flagOf(a), 0.6);
    await s.store.insertResearch(done({ trigger: "flag", flagId: "older" }));
    expect(await run(s)).toBe(2); // 3 - 1 already used today
    expect(await run(s)).toBe(0);
    expect(await run(s, { INTEL_RESEARCH_AUTO_DAILY: "0" })).toBe(0);
  });

  test("failed flag runs were billed: they count toward the auto cap (capped ones do not)", async () => {
    const s = setup();
    for (const a of ["ETH", "BTC"]) await seedFlag(s.store, flagOf(a), 0.6);
    for (const id of ["f1", "f2", "f3"]) await s.store.insertResearch(done({ trigger: "flag", flagId: id, status: "failed" }));
    expect(await run(s)).toBe(0);
    expect(s.provider.prompts).toHaveLength(0);
    const t = setup();
    await seedFlag(t.store, flagOf("ETH"), 0.6);
    for (const id of ["c1", "c2", "c3"]) await t.store.insertResearch(done({ trigger: "flag", flagId: id, status: "capped" }));
    expect(await run(t)).toBe(1);
  });

  test("budget gate: no run starts unless more than the research deadline is left", async () => {
    const s = setup();
    for (const a of ["ETH", "BTC", "AVAX"]) await seedFlag(s.store, flagOf(a), 0.6);
    expect(await run(s, {}, () => RESEARCH_DEADLINE_MS)).toBe(0);
    let calls = 0;
    expect(await run(s, {}, () => (calls++ === 0 ? RESEARCH_DEADLINE_MS + 1 : 0))).toBe(1);
    expect(s.provider.prompts).toHaveLength(1);
  });
});
