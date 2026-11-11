import { describe, expect, test } from "bun:test";
import { AgentRecordsResponseSchema, AgentStatsResponseSchema, TriageResponseSchema } from "../../shared/agentRecords.js";
import type { MoveDetail } from "../../shared/moves.js";
import { EmitProvider, llmDeps } from "../intel/fixtures/emit-provider.js";
import { MemoryPlatformStore } from "../platform/store-memory.js";
import { detail, iso, record, T0 } from "./agent.fixture.js";
import type { AgentOutput } from "./agent.js";
import { moveAgentRoutes, type MoveAgentDeps } from "./agentRoutes.js";

const out: AgentOutput = { claim: "No public cause beyond the residual.", layer: "unexplained", direction: "long", assets: [], falsifierLevel: null, falsifierText: "", sources: [] };
const day = "2026-11-11";

function setup(o: Partial<MoveAgentDeps> & { provider?: EmitProvider | null; cap?: number; guest?: boolean; coin?: (c: string) => MoveDetail } = {}) {
  const store = new MemoryPlatformStore();
  const provider = o.provider === undefined ? new EmitProvider(() => out) : o.provider;
  const agent = { llm: llmDeps(provider, undefined, () => new Date(T0)), now: () => new Date(T0), dailyCap: o.cap ?? 6, inflight: new Set<string>() };
  const deps: MoveAgentDeps = {
    unavailable: () => null,
    store: () => store,
    moves: () => ({ coin: async (c) => (o.coin ?? ((x: string) => detail(x)))(c) }),
    agent: () => agent,
    budget: 8,
    mark: async () => 60000,
    scan: () => ({ day, at: iso(T0), state: "ok", reason: null, watched: 38, overBudget: 4 }),
    now: () => new Date(T0),
    isGuest: () => o.guest ?? false,
    ...o,
  };
  const app = moveAgentRoutes(deps);
  return { store, agent, app, provider, req: (path: string, init?: RequestInit) => app.request(path, init) };
}
const post = { method: "POST" };

describe("GET /triage", () => {
  test("the day's queue with records, budget, runs and why an investigation is blocked", async () => {
    const { store, req } = setup({ cap: 1 });
    await store.insertAgentRecord(record({ id: "r1", createdAt: iso(T0 - 3_600_000) }));
    await store.upsertTriageItem({ id: `${day}:SOL`, day, coin: "SOL", reason: "residual +6.2% · z +3.1 · 24h · no news in window", score: 1.24, residualZ: 3.1, surfacedAt: iso(T0), dismissedAt: null, recordId: "r1" });
    await store.upsertTriageItem({ id: `${day}:WIF`, day, coin: "WIF", reason: "FADE 3/3 · crowd long 3/4", score: 1, residualZ: 0.4, surfacedAt: iso(T0), dismissedAt: iso(T0), recordId: null });
    const res = await req("/triage");
    expect(res.status).toBe(200);
    const body = TriageResponseSchema.parse(await res.json());
    expect(body).toMatchObject({ state: "ok", reason: null, day, budget: 8, surfaced: 2, overBudget: 4, watched: 38, agentRuns: 1, agentCap: 1, agentBlockedReason: "moves agent cap reached (1/1 today)" });
    expect(body.items.map((i) => [i.coin, i.record?.id ?? null, i.dismissedAt !== null])).toEqual([["SOL", "r1", false], ["WIF", null, true]]);
  });

  test("guests see the queue without model-written records", async () => {
    const { store, req } = setup({ guest: true });
    await store.insertAgentRecord(record({ id: "r1" }));
    await store.upsertTriageItem({ id: `${day}:SOL`, day, coin: "SOL", reason: "x", score: 1, residualZ: 3, surfacedAt: iso(T0), dismissedAt: null, recordId: "r1" });
    const body = TriageResponseSchema.parse(await (await req("/triage")).json());
    expect(body.items[0]!.record).toBeNull();
    expect((await req("/records")).status).toBe(401);
  });

  test("the stored triage pass: none yet, stale (older than 30 min), or the pass's own reason", async () => {
    const reason = async (scan: MoveAgentDeps["scan"]) => TriageResponseSchema.parse(await (await setup({ scan }).req("/triage")).json()).reason;
    expect(await reason(async () => null)).toBe("no moves run stored yet");
    expect(await reason(async () => ({ day, at: iso(T0 - 45 * 60_000), state: "ok", reason: null, watched: 38, overBudget: 0 }))).toBe("latest triage pass is 45 min old; the moves-agent job is expected every 15 min");
    expect(await reason(async () => ({ day, at: iso(T0), state: "pending", reason: "first run", watched: 0, overBudget: 0 }))).toBe("first run");
  });

  test("no provider: the queue says so", async () => {
    const body = TriageResponseSchema.parse(await (await setup({ provider: null }).req("/triage")).json());
    expect(body.agentBlockedReason).toBe("no LLM provider configured");
  });

  test("serverless or no store: `unavailable` with the reason, never an error", async () => {
    for (const o of [{ unavailable: () => "needs the always-on server; or run `bun start`" }, { store: () => null }]) {
      const { req } = setup(o);
      const res = await req("/triage");
      expect(res.status).toBe(200);
      const body = TriageResponseSchema.parse(await res.json());
      expect(body).toMatchObject({ state: "unavailable", items: [], agentBlockedReason: body.reason });
      expect(body.reason).toBeTruthy();
      const inv = await req("/SOL/investigate", post);
      expect(inv.status).toBe(503);
      expect(await inv.json()).toEqual({ error: "unavailable", reason: body.reason });
    }
  });
});

describe("POST /:coin/investigate", () => {
  test("runs one investigation, stores it and links today's triage item", async () => {
    const { store, req } = setup();
    await store.upsertTriageItem({ id: `${day}:SOL`, day, coin: "SOL", reason: "x", score: 1, residualZ: 3, surfacedAt: iso(T0), dismissedAt: null, recordId: null });
    const res = await req("/SOL/investigate", post);
    expect(res.status).toBe(200);
    const r = await res.json();
    expect(r).toMatchObject({ coin: "SOL", trigger: "manual", status: "open", inputs: { btcAtCreate: 60000 } });
    expect((await store.listTriage(day))[0]!.recordId).toBe(r.id);
  });

  test("409 in flight, 429 at the cap (stored as capped, no call), 503 without a provider, 400 on bad input", async () => {
    const s = setup({ cap: 0 });
    s.agent.inflight.add("SOL");
    expect((await s.req("/SOL/investigate", post)).status).toBe(409);
    s.agent.inflight.clear();
    const capped = await s.req("/SOL/investigate", post);
    expect(capped.status).toBe(429);
    expect(await capped.json()).toMatchObject({ status: "capped", claim: "" });
    expect(s.provider!.prompts).toHaveLength(0);
    const none = await setup({ provider: null }).req("/SOL/investigate", post);
    expect(none.status).toBe(503);
    expect(await none.json()).toMatchObject({ status: "failed", error: "no LLM provider configured" });
    expect((await s.req("/SOL/investigate?window=1d", post)).status).toBe(400);
    expect((await s.req("/so!l/investigate", post)).status).toBe(400);
    const noData = setup({ coin: (c) => ({ ...detail(c), state: "unavailable", reason: "SOL needs 120 of 168 hourly bars" }) });
    const nd = await noData.req("/SOL/investigate", post);
    expect([nd.status, (await nd.json()).reason]).toEqual([503, "SOL needs 120 of 168 hourly bars"]);
  });
});

describe("POST /:coin/proposal (the routine)", () => {
  const body = (over: Record<string, unknown> = {}) => ({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      claim: "The 6.2% residual came with no news hour.", layer: "narrative", direction: "long", assets: ["SOL"], horizonHours: 24,
      falsifier: { level: 9.5, side: "below", text: "A trade below 9.5 breaks it." },
      sources: [{ url: "https://news.example.com/sol", title: "SOL news", ts: "2026-11-10T09:00:00Z" }],
      ...over,
    }),
  });
  const item = (coin: string, over: Record<string, unknown> = {}) => ({ id: `${day}:${coin}`, day, coin, reason: "x", score: 1, residualZ: 3, surfacedAt: iso(T0), dismissedAt: null, recordId: null, ...over });

  test("code stamps, vets and stores the record (trigger routine, sources unobserved) and links the item; a second is 409", async () => {
    const windows: string[] = [];
    const { store, provider, req } = setup({ moves: () => ({ coin: async (c, w) => (windows.push(w), detail(c)) }) });
    await store.upsertTriageItem(item("SOL"));
    const res = await req("/SOL/proposal", body());
    expect(res.status).toBe(200);
    const r = await res.json();
    expect(r).toMatchObject({
      coin: "SOL", trigger: "routine", model: "routine", status: "open", layer: "narrative", direction: "long", horizonHours: 24, dropped: 0,
      inputs: { window: "24h", residualPct: 6.2, residualZ: 3.1, markAtCreate: 10, btcAtCreate: 60000 }, falsifier: { level: 9.5, side: "below" },
      sources: [{ url: "https://news.example.com/sol", observed: false }],
    });
    expect((await store.listTriage(day))[0]!.recordId).toBe(r.id);
    expect(provider!.prompts).toHaveLength(0); // no provider call
    const again = await req("/SOL/proposal", body());
    expect([again.status, (await again.json()).error]).toEqual([409, `the SOL triage item already has record ${r.id}`]);
    expect(windows).toEqual(["24h"]);
  });

  test("no_cause is expressible; horizon 72 builds on the 72h window", async () => {
    const windows: string[] = [];
    const { store, req } = setup({ moves: () => ({ coin: async (c, w) => (windows.push(w), detail(c, { window: w })) }) });
    await store.upsertTriageItem(item("SOL"));
    await store.upsertTriageItem(item("WIF"));
    const nc = await req("/SOL/proposal", body({ claim: "", layer: "unexplained", direction: null, falsifier: null, sources: [] }));
    expect(await nc.json()).toMatchObject({ status: "no_cause", claim: "", direction: null, trigger: "routine" });
    const h72 = await (await req("/WIF/proposal", body({ horizonHours: 72, falsifier: null }))).json();
    expect([h72.horizonHours, h72.inputs.window, windows]).toEqual([72, "72h", ["24h", "72h"]]);
  });

  test("refusals: 404 no item today, 409 dismissed or in flight, 400 bad body, 422 rejected claim, 429 cap, 503 no store; nothing stored", async () => {
    const s = setup({ cap: 1 });
    expect([(await s.req("/SOL/proposal", body())).status]).toEqual([404]);
    await s.store.upsertTriageItem(item("WIF", { dismissedAt: iso(T0) }));
    expect((await s.req("/WIF/proposal", body())).status).toBe(409);
    await s.store.upsertTriageItem(item("SOL"));
    s.agent.inflight.add("SOL");
    expect((await s.req("/SOL/proposal", body())).status).toBe(409);
    s.agent.inflight.clear();
    for (const bad of [{ status: "graded" }, { inputs: {} }, { falsifier: { level: 11, side: "above", text: "x" } }, { layer: "vibes" }]) expect((await s.req("/SOL/proposal", body(bad))).status).toBe(400);
    expect((await s.req("/SOL/proposal", { method: "POST", body: "not json" })).status).toBe(400);
    const rejected = await s.req("/SOL/proposal", body({ claim: "Open interest jumped 47%. Sell now." }));
    expect([rejected.status, (await rejected.json()).error]).toEqual([422, expect.stringContaining("failed the number or advice check")]);
    await s.store.insertAgentRecord(record({ id: "earlier", coin: "JUP", createdAt: iso(T0 - 3_600_000) }));
    const capped = await s.req("/SOL/proposal", body());
    expect([capped.status, (await capped.json()).error]).toEqual([429, "moves agent cap reached (1/1 today)"]);
    expect((await s.store.listAgentRecords({ limit: 10 })).map((r) => r.id)).toEqual(["earlier"]);
    expect((await s.store.listTriage(day)).every((i) => i.recordId === null)).toBe(true);
    expect((await setup({ store: () => null }).req("/SOL/proposal", body())).status).toBe(503);
  });
});

describe("records, stats and dismiss", () => {
  test("records filter by coin and status; stats carry n; dismiss stamps once", async () => {
    const { store, req } = setup();
    await store.insertAgentRecord(record({ id: "a", coin: "SOL" }));
    await store.insertAgentRecord(record({ id: "b", coin: "WIF", status: "no_cause", direction: null, createdAt: iso(T0 + 1000) }));
    const all = AgentRecordsResponseSchema.parse(await (await req("/records")).json());
    expect(all.records.map((r) => r.id)).toEqual(["b", "a"]);
    expect(AgentRecordsResponseSchema.parse(await (await req("/records?coin=SOL&status=open")).json()).records.map((r) => r.id)).toEqual(["a"]);
    expect((await req("/records?status=nope")).status).toBe(400);
    const stats = AgentStatsResponseSchema.parse(await (await req("/records/stats")).json());
    expect(stats).toEqual({ total: 2, graded: 0, noCause: 1, byHorizon: [], byLayer: [] });

    await store.upsertTriageItem({ id: `${day}:SOL`, day, coin: "SOL", reason: "x", score: 1, residualZ: 3, surfacedAt: iso(T0), dismissedAt: null, recordId: null });
    const d = await req(`/triage/${day}:SOL/dismiss`, post);
    expect(d.status).toBe(200);
    expect((await d.json()).item.dismissedAt).toBe(iso(T0));
    expect((await req(`/triage/${day}:NOPE/dismiss`, post)).status).toBe(404);
  });
});
