import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { AssetDetailResponseSchema, HeatmapResponseSchema, type FlowFlag, type ResearchResult } from "../../../shared/intel.js";
import type { Citation, Conversation, LLMProvider, StepResult } from "../../llm/provider.js";
import { llmDeps } from "../../intel/fixtures/emit-provider.js";
import { flowAlerts } from "../../intel/flowEvents.js";
import { exposureOf, mapperDeps, position } from "../../intel/fixtures/mapper-deps.js";
import { AUTO_RESEARCH_MARGIN_MS, autoResearch, RESEARCH_DEADLINE_MS, type AutoResearchRun } from "../../intel/research.js";
import { researchStage } from "../cron.js";
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
  /** Answers with an invalid object: both attempts are rejected, the run fails after billing its calls. */
  broken = false;
  start(_system: string, _history: unknown[], question: string): Conversation {
    this.prompts.push(question);
    const self = this;
    return {
      async step(_tools, hooks): Promise<StepResult> {
        hooks.onServerToolCall?.({ id: "s0", name: "web_search", input: {} });
        hooks.onSearchResults?.([{ url: URL_A, title: "Jito exploit drains $12M" }]);
        for (const c of CITES) hooks.onCitation?.(c);
        return { stop: "tool_use", toolCalls: [{ id: "t1", name: "emit", input: self.broken ? { nope: true } : FOUND }], usage: { input_tokens: 1000, output_tokens: 500 } };
      },
      addToolResults() {},
    };
  }
}

const flagOf = (asset: string, name = "crowded_long"): FlowFlag => ({ id: `detector:${name}:${asset}:24h:x`, asset, kind: "detector", name, window: "24h", numbers: { oi_z: 2.4 }, score: 2.4, degraded: false, ts: "2026-10-14T11:00:00.000Z", researchId: null });

function setup(env: Record<string, string> = {}, dailyUsd?: number) {
  const clock = { t: NOW };
  const now = () => clock.t;
  const store = new MemoryIntelStore(now);
  const provider = new Provider();
  const llm = { ...llmDeps(provider, store, now), dailyUsd };
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
    now,
  } as unknown as IntelDeps;
  const app = new Hono().basePath("/api").route("/intel", createIntelRoutes(deps));
  const call = async (path: string, body?: unknown) => {
    const res = await app.request(`/api/intel${path}`, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  return { store, provider, llm, deps, call, clock };
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

  test("a lowercase asset is stored uppercase and shows on /asset/SOL; GET filters case-insensitively", async () => {
    const { call } = setup();
    const { body } = await call("/research", { question: "Why did sol move?", asset: "sol" });
    expect(body.asset).toBe("SOL");
    const a = AssetDetailResponseSchema.parse((await call("/asset/SOL?days=2")).body);
    expect(a.events.map((e) => e.kind)).toEqual(["research"]);
    expect((await call("/research?asset=sol")).body.items).toHaveLength(1);
  });

  test("failed runs that billed count toward INTEL_RESEARCH_DAILY; free failures do not", async () => {
    const { store, call } = setup({ INTEL_RESEARCH_DAILY: "2" });
    await store.insertResearch(done({ status: "failed", costUsd: 0.2 }));
    await store.insertResearch(done({ status: "failed", costUsd: 0 }));
    expect((await call("/research", { question: "Why did SOL move?" })).status).toBe(200); // 1 counted so far
    expect((await call("/research", { question: "Why did SOL move?" })).status).toBe(429);
  });
});

/** 15-min SOL snapshots over 5 days, flat then a jump and a depth collapse in the last 45 min (as in flow.test.ts). */
async function seedSol(store: MemoryIntelStore) {
  const rows = Array.from({ length: 5 * 96 + 1 }, (_, k) => {
    const i = 5 * 96 - k;
    const jitter = 1 + 0.002 * (Math.abs((Math.sin(i * 12.9898) * 43758.5453) % 1) - 0.5);
    return { asset: "SOL", ts: new Date(NOW.getTime() - i * 900_000).toISOString(), price: i <= 3 ? 110 : 100 * jitter, vol24h: null, funding: 1e-5, oiUsd: null, premium: null, basis: null, depthBid1: null, depthAsk1: null, depthBid2: i === 0 ? 1.5e5 : 5e5, depthAsk2: i === 0 ? 1.5e5 : 5e5, spreadBps: null };
  });
  await store.insertSnapshots(rows);
}

describe("research joins", () => {
  test("/flows carries researchId read-time; failed rows do not join and the stored flag stays untouched", async () => {
    const { store, call } = setup();
    const flag = flagOf("SOL");
    await seedFlag(store, flag, 0.5);
    const r = await store.insertResearch(done({ flagId: flag.id }));
    await store.insertResearch(done({ flagId: flag.id, status: "failed" })); // newer, but never joins
    const flows = (await call("/flows")).body as { flags: FlowFlag[] };
    expect(flows.flags).toMatchObject([{ id: flag.id, researchId: r.id }]);
    expect((await store.listEvents({ type: "data", limit: 5 }))[0]!.flag!.researchId).toBeNull();
  });

  test("a running row is not joined", async () => {
    const { store, call } = setup();
    const flag = flagOf("SOL");
    await seedFlag(store, flag, 0.5);
    await store.acquireResearch(done({ status: "running", flagId: flag.id }), 60_000);
    expect(((await call("/flows")).body as { flags: FlowFlag[] }).flags[0]!.researchId).toBeNull();
  });

  test("a live heatmap flag carries the stored episode's id, so researchId joins after the clock moved on", async () => {
    const s = setup();
    await seedSol(s.store);
    const live0 = HeatmapResponseSchema.parse((await s.call("/heatmap?window=1h")).body).flags.find((f) => f.name === "liquidity_thinning")!;
    // No stored episode yet: the live id stays, nothing joins, and POST with it is an unknown flag.
    expect(live0.researchId).toBeNull();
    expect((await s.call("/research", { question: "Why did SOL move?", flagId: live0.id })).status).toBe(404);

    const base = mapperDeps({ provider: null, store: s.store, positions: [position("SOL", "long", 10_000)], clock: { now: NOW } });
    const stored = (await flowAlerts(base, NOW)).events.find((e) => e.flag!.name === "liquidity_thinning")!.flag!;
    s.clock.t = new Date(NOW.getTime() + 10 * 60_000);
    const live = HeatmapResponseSchema.parse((await s.call("/heatmap?window=1h")).body).flags.find((f) => f.name === "liquidity_thinning")!;
    expect(live.id).toBe(stored.id);
    expect(live.researchId).toBeNull();

    const post = await s.call("/research", { question: "Why did SOL move?", flagId: live.id });
    expect(post.status).toBe(200);
    const after = HeatmapResponseSchema.parse((await s.call("/heatmap?window=1h")).body).flags;
    expect(after.find((f) => f.id === stored.id)?.researchId).toBe(post.body.id as string);
    expect(after.filter((f) => f.id !== stored.id).every((f) => f.researchId === null)).toBe(true);
  });

  test("a failing research read never fails heatmap or flows: every researchId is null", async () => {
    const s = setup();
    await seedSol(s.store);
    await seedFlag(s.store, flagOf("SOL"), 0.5);
    s.store.researchForFlags = async () => Promise.reject(new Error("intel_research down"));
    const hm = await s.call("/heatmap?window=1h");
    expect(hm.status).toBe(200);
    expect(HeatmapResponseSchema.parse(hm.body).flags.every((f) => f.researchId === null)).toBe(true);
    const flows = await s.call("/flows");
    expect(flows.status).toBe(200);
    expect((flows.body as { flags: FlowFlag[] }).flags.every((f) => f.researchId === null)).toBe(true);
  });

  test("/asset/:coin shows found (observed) and no_cause (hypothesis) results only, ascending", async () => {
    const { store, call } = setup();
    await store.upsertEvents([
      { key: "cat:1", type: "upgrade", title: "SOL upgrade", summary: null, entities: ["SOL"], assets: ["SOL"], magnitude: "med", sources: [{ label: "manual" }], origin: "manual", firstSeen: NOW.toISOString(), scheduledAt: new Date(NOW.getTime() + 3_600_000).toISOString(), catalyst: null, tag: "hypothesis" },
    ]);
    const found = await store.insertResearch(done({ question: "found one" }));
    const noCause = await store.insertResearch(done({ question: "no cause one", status: "no_cause" }));
    await store.insertResearch(done({ status: "failed", costUsd: 0.1 }));
    await store.insertResearch(done({ status: "capped" }));
    await store.acquireResearch(done({ status: "running" }), 60_000);
    await store.insertResearch(done({ asset: "ETH" }));
    const a = AssetDetailResponseSchema.parse((await call("/asset/SOL?days=2")).body);
    expect(a.events.map((e) => e.kind)).toEqual(["research", "research", "catalyst"]);
    expect(a.events[0]).toMatchObject({ title: "found one", tag: "observed", research: { id: found.id } });
    expect(a.events[1]).toMatchObject({ title: "no cause one", tag: "hypothesis", research: { id: noCause.id } });
  });
});

describe("autoResearch", () => {
  const run = (s: Setup, env: Record<string, string> = {}, left: () => number = () => 200_000, signal?: AbortSignal) =>
    autoResearch({ store: s.store, llm: s.llm, exposure: s.deps.exposure, now: s.deps.now, pushMateriality: 0.35, env, left, signal });
  const ENOUGH = RESEARCH_DEADLINE_MS + AUTO_RESEARCH_MARGIN_MS;

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
    expect(await run(s, { INTEL_RESEARCH_AUTO_DAILY: "5" })).toEqual({ ran: 2, statuses: { found: 2, no_cause: 0, failed: 0 }, stopped: "none" });
    expect(s.provider.prompts.map((p) => /Why did (\w+)/.exec(p)![1])).toEqual(["BTC", "ETH"]);
    expect(s.store.research.filter((r) => r.trigger === "flag" && r.status !== "running").map((r) => r.flagId)).toEqual([avax!.id, btc!.id, eth!.id]);
    expect((await run(s, { INTEL_RESEARCH_AUTO_DAILY: "5" })).ran).toBe(0); // everything left is explained now
  });

  test("respects INTEL_RESEARCH_AUTO_DAILY (default 3) per UTC day, counting earlier flag runs", async () => {
    const s = setup();
    for (const a of ["ETH", "BTC", "AVAX", "DOGE"]) await seedFlag(s.store, flagOf(a), 0.6);
    await s.store.insertResearch(done({ trigger: "flag", flagId: "older" }));
    expect(await run(s)).toMatchObject({ ran: 2, stopped: "limit" }); // 3 - 1 already used today
    expect(await run(s)).toMatchObject({ ran: 0, stopped: "limit" });
    expect((await run(s, { INTEL_RESEARCH_AUTO_DAILY: "0" })).ran).toBe(0);
  });

  test("billed failed flag runs count toward the auto cap; free failures and capped ones do not", async () => {
    const s = setup();
    await seedFlag(s.store, flagOf("ETH"), 0.6);
    for (const id of ["f1", "f2", "f3"]) await s.store.insertResearch(done({ trigger: "flag", flagId: id, status: "failed", costUsd: 0.2 }));
    expect(await run(s)).toMatchObject({ ran: 0, stopped: "limit" });
    expect(s.provider.prompts).toHaveLength(0);
    const t = setup();
    await seedFlag(t.store, flagOf("ETH"), 0.6);
    for (const id of ["c1", "c2"]) await t.store.insertResearch(done({ trigger: "flag", flagId: id, status: "capped" }));
    for (const id of ["z1", "z2"]) await t.store.insertResearch(done({ trigger: "flag", flagId: id, status: "failed", costUsd: 0 }));
    expect((await run(t)).ran).toBe(1);
  });

  test("one attempt per flag per UTC day: the same flag failing twice uses one slot", async () => {
    const s = setup();
    s.provider.broken = true;
    await seedFlag(s.store, flagOf("ETH"), 0.6);
    const first = await run(s);
    expect(first).toMatchObject({ ran: 1, statuses: { failed: 1 } });
    expect(await run(s)).toMatchObject({ ran: 0 });
    expect(await s.store.researchCountSince(new Date("2026-10-14T00:00:00Z"), "flag")).toBe(1); // failed but billed
    s.clock.t = new Date("2026-10-15T01:00:00Z"); // next UTC day: the flag is still unexplained, but its alert is older than 6 h
    expect((await run(s)).ran).toBe(0);
  });

  test("stops at the first capped result without counting it", async () => {
    const s = setup({}, 0);
    for (const a of ["ETH", "BTC"]) await seedFlag(s.store, flagOf(a), 0.6);
    expect(await run(s)).toEqual({ ran: 0, statuses: { found: 0, no_cause: 0, failed: 0 }, stopped: "cap" });
    expect(s.store.research.filter((r) => r.status === "capped")).toHaveLength(1);
    expect(s.provider.prompts).toHaveLength(0);
  });

  test("stops when another run holds the lock", async () => {
    const s = setup();
    await seedFlag(s.store, flagOf("ETH"), 0.6);
    await s.store.acquireResearch(done({ status: "running" }), 60_000);
    expect(await run(s)).toMatchObject({ ran: 0, stopped: "lock" });
  });

  test("budget gate: a run starts only with more than the deadline plus the margin left", async () => {
    const s = setup();
    for (const a of ["ETH", "BTC", "AVAX"]) await seedFlag(s.store, flagOf(a), 0.6);
    expect(await run(s, {}, () => ENOUGH)).toMatchObject({ ran: 0, stopped: "budget" });
    let calls = 0;
    expect(await run(s, {}, () => (calls++ === 0 ? ENOUGH + 1 : 0))).toMatchObject({ ran: 1, stopped: "budget" });
    expect(s.provider.prompts).toHaveLength(1);
  });

  test("the job's abort signal reaches the run", async () => {
    const s = setup();
    await seedFlag(s.store, flagOf("ETH"), 0.6);
    const ctl = new AbortController();
    ctl.abort();
    expect(await run(s, {}, undefined, ctl.signal)).toMatchObject({ ran: 1, statuses: { failed: 1 } });
    expect(s.provider.prompts).toHaveLength(0);
  });

  test("a busy news feed does not hide flow alerts: news is read apart from flow", async () => {
    const s = setup();
    await seedFlag(s.store, flagOf("ETH"), 0.6);
    for (let i = 0; i < 600; i++) await newsAlert(s.store, `N${i}`);
    expect((await run(s)).ran).toBe(1);
  });
});

describe("researchStage (ingest's last stage)", () => {
  const deps = () => {
    const s = setup();
    return { store: s.store, llm: s.llm, exposure: s.deps.exposure, now: s.deps.now, pushMateriality: 0.35, env: {} };
  };
  const ok: AutoResearchRun = { ran: 1, statuses: { found: 1, no_cause: 0, failed: 0 }, stopped: "none" };

  test("a normal run reports the research summary and records collector_runs intel:research", async () => {
    const recorded: unknown[][] = [];
    const res = await researchStage(deps(), { left: () => 200_000 }, async () => ok, async (...a) => void recorded.push(a));
    expect(res).toEqual(ok);
    expect(recorded.map((r) => [r[0], r[2], r[3]])).toEqual([["intel:research", true, null]]);
  });

  test("failed research marks the run not ok", async () => {
    const recorded: unknown[][] = [];
    await researchStage(deps(), { left: () => 200_000 }, async () => ({ ...ok, statuses: { found: 0, no_cause: 0, failed: 1 } }), async (...a) => void recorded.push(a));
    expect(recorded[0]![2]).toBe(false);
  });

  test("a throwing autoResearch is reported, never thrown", async () => {
    const recorded: unknown[][] = [];
    const res = await researchStage(deps(), { left: () => 200_000 }, async () => Promise.reject(new Error("boom")), async (...a) => void recorded.push(a));
    expect(res).toEqual({ ran: 0, error: "boom" });
    expect(recorded[0]!.slice(2)).toEqual([false, "boom"]);
    await researchStage(deps(), { left: () => 200_000 }, async () => ok, async () => Promise.reject(new Error("db down"))); // a failed record is swallowed
  });

  test("low budget: skipped, nothing run or recorded", async () => {
    let ran = false;
    const res = await researchStage(deps(), { left: () => RESEARCH_DEADLINE_MS + AUTO_RESEARCH_MARGIN_MS }, async () => ((ran = true), ok), async () => void (ran = true));
    expect(res).toEqual({ ran: 0, skipped: true });
    expect(ran).toBe(false);
  });
});

