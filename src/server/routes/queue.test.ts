import { describe, expect, test } from "bun:test";
import { QueueDismissResponseSchema, QueueResponseSchema } from "../../shared/queue.js";
import { EmitProvider, llmDeps } from "../intel/fixtures/emit-provider.js";
import { iso, record, T0 } from "../moves/agent.fixture.js";
import type { AgentOutput } from "../moves/agent.js";
import { needsAlwaysOn } from "../platform/runtime.js";
import { MemoryPlatformStore } from "../platform/store-memory.js";
import { queueRoutes, type QueueRouteDeps } from "./queue.js";

const out: AgentOutput = { claim: "No public cause beyond the residual.", layer: "unexplained", direction: "long", assets: [], falsifierLevel: null, falsifierText: "", sources: [] };
const day = "2026-11-11";
const post = { method: "POST" };

function setup(o: Partial<QueueRouteDeps> & { guest?: boolean; noStore?: boolean } = {}) {
  const store = new MemoryPlatformStore();
  const calls = { dismissQueue: 0, dismissTriage: 0 };
  const dq = store.dismissQueue.bind(store);
  const dt = store.dismissTriage.bind(store);
  store.dismissQueue = (...a) => (calls.dismissQueue++, dq(...a));
  store.dismissTriage = (...a) => (calls.dismissTriage++, dt(...a));
  const agent = { llm: llmDeps(new EmitProvider(() => out), undefined, () => new Date(T0)), now: () => new Date(T0), dailyCap: 6, inflight: new Set<string>() };
  const deps: QueueRouteDeps = {
    now: () => new Date(T0),
    cap: 8,
    store: () => (o.noStore ? null : store),
    movesUnavailable: () => null,
    opportunities: async () => [],
    radar: async () => [],
    agent: () => agent,
    isGuest: () => o.guest ?? false,
    timeoutMs: 50,
    ...o,
  };
  const app = queueRoutes(deps);
  return { store, calls, req: (path: string, init?: RequestInit) => app.request(path, init) };
}

const triage = (coin: string, over = {}) => ({
  id: `${day}:${coin}`, day, coin, reason: "residual +6.2% · z +3.1 · 24h · no news in window", score: 1.24, residualZ: 3.1, surfacedAt: iso(T0 - 3_600_000), dismissedAt: null, recordId: null, ...over,
});

describe("GET /api/queue", () => {
  test("merges the day's triage with records and agent counts; the answer parses", async () => {
    const { store, req } = setup();
    await store.insertAgentRecord(record({ id: "r1", createdAt: iso(T0 - 1_800_000) }));
    await store.upsertTriageItem(triage("SOL", { recordId: "r1" }));
    const res = await req("/");
    expect(res.status).toBe(200);
    const body = QueueResponseSchema.parse(await res.json());
    expect(body).toMatchObject({ day, cap: 8, overCap: 0, agentCap: 6, agentBlockedReason: null });
    expect(body.items.map((i) => [i.coin, i.record?.id ?? null])).toEqual([["SOL", "r1"]]);
    expect(body.sources.radar).toEqual({ state: "ok", reason: null, count: 0 });
  });

  test("serverless: moves is unavailable with the always-on reason; a failing or slow source does not empty the queue", async () => {
    const reason = needsAlwaysOn("bun start");
    const { req } = setup({
      movesUnavailable: () => reason,
      opportunities: () => new Promise(() => {}),
      radar: async () => [{ id: "c1", date: day, at: iso(T0 - 600_000), market: "HYPE", stance: "ride", direction: "long", kind: "catalyst", thesis: "x".repeat(20), cause_url: "https://e.com", cause_date: day, kill_price: 30, kill_if: "close below", mark: 33, btc: 60000, rel: {}, killed_at: null }],
    });
    const body = QueueResponseSchema.parse(await (await req("/")).json());
    expect(body.sources.moves).toEqual({ state: "unavailable", reason, count: 0 });
    expect(body.sources.opportunity.state).toBe("unavailable");
    expect(body.items.map((i) => i.coin)).toEqual(["HYPE"]);
    expect(body.agentBlockedReason).toBe(reason);
  });

  test("no store: 200 with every store-backed source unavailable", async () => {
    const body = QueueResponseSchema.parse(await (await setup({ noStore: true }).req("/")).json());
    expect(body.sources.moves.state).toBe("unavailable");
    expect(body.sources.opportunity.state).toBe("unavailable");
    expect(body.sources.radar.state).toBe("ok");
    expect(body.items).toEqual([]);
  });

  test("a guest gets no radar and no records", async () => {
    const { store, req } = setup({ guest: true });
    await store.insertAgentRecord(record({ id: "r1", createdAt: iso(T0 - 1_800_000) }));
    await store.upsertTriageItem(triage("SOL", { recordId: "r1" }));
    const body = QueueResponseSchema.parse(await (await req("/")).json());
    expect(body.sources.radar).toEqual({ state: "unavailable", reason: "sign in required", count: 0 });
    expect(body.items[0]!.record).toBeNull();
  });
});

describe("POST /api/queue/:id/dismiss", () => {
  test("a bad id or another day is 400 with field id", async () => {
    const { req, calls } = setup();
    for (const id of ["nope", "2026-11-11:bad coin!", "2026-11-10:SOL"]) {
      const res = await req(`/${encodeURIComponent(id)}/dismiss`, post);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ field: "id" });
    }
    expect(calls).toEqual({ dismissQueue: 0, dismissTriage: 0 });
  });

  test("dismisses the queue item and the coin's triage item once each; the queue then shows it dismissed", async () => {
    const { store, req, calls } = setup();
    await store.upsertTriageItem(triage("SOL"));
    const res = await req(`/${encodeURIComponent(`${day}:SOL`)}/dismiss`, post);
    expect(res.status).toBe(200);
    expect(QueueDismissResponseSchema.parse(await res.json())).toEqual({ id: `${day}:SOL`, dismissedAt: iso(T0) });
    expect(calls).toEqual({ dismissQueue: 1, dismissTriage: 1 });
    expect((await store.listTriage(day))[0]!.dismissedAt).toBe(iso(T0));
    const body = QueueResponseSchema.parse(await (await req("/")).json());
    expect(body.items[0]).toMatchObject({ coin: "SOL", state: "dismissed" });
  });

  test("a dex-prefixed coin without a triage item is dismissed in the queue only", async () => {
    const { store, req } = setup();
    expect((await req(`/${encodeURIComponent(`${day}:xyz:TSLA`)}/dismiss`, post)).status).toBe(200);
    expect(await store.listQueueDismissals(day)).toEqual([{ day, coin: "xyz:TSLA", dismissedAt: iso(T0) }]);
  });

  test("no store: 503 with the reason", async () => {
    const res = await setup({ noStore: true }).req(`/${day}:SOL/dismiss`, post);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "unavailable", reason: expect.any(String) });
  });
});
