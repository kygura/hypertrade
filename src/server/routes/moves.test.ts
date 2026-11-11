import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { AgentRecordSchema, type AgentRecord } from "../../shared/agentRecords.js";
import { MoveDetailSchema, MovesResponseSchema, type MoveDetail, type MovesResponse, type MoveWindow } from "../../shared/moves.js";
import detailFixture from "../moves/fixtures/move-detail.json" with { type: "json" };
import responseFixture from "../moves/fixtures/moves-response.json" with { type: "json" };
import { UnknownCoinError } from "../moves/service.js";
import { agentsLayer, movesRoutes } from "./moves.js";

const RESPONSE = MovesResponseSchema.parse(responseFixture);
const DETAIL = MoveDetailSchema.parse(detailFixture);
const RECORD: AgentRecord = AgentRecordSchema.parse({
  id: "r1", coin: "COIN", createdAt: "2026-11-10T12:05:00.000Z", trigger: "manual",
  inputs: { window: "24h", residualPct: 5, residualZ: 9, totalPct: 6, markAtCreate: 10, btcAtCreate: 90_000, asOf: "2026-11-10T12:00:00.000Z" },
  claim: "listing announced", assets: ["COIN"], direction: "long", horizonHours: 24, layer: "narrative", falsifier: null, sources: [],
  status: "open", grade: null, model: "m", promptVersion: "moves-agent-v1", dropped: 0,
});

function app(o: { guest?: boolean; triage?: unknown; universe?: (w: MoveWindow) => Promise<MovesResponse>; coin?: (c: string, w: MoveWindow) => Promise<MoveDetail> } = {}) {
  const calls: Array<[string, string]> = [];
  const agents = new Hono()
    .get("/triage", (c) => (o.triage === undefined ? c.json({ error: "x" }, 503) : c.json(o.triage)))
    .get("/records", (c) => c.json({ records: [] }));
  const routes = movesRoutes({
    service: () => ({
      universe: o.universe ?? (async (w) => (calls.push(["universe", w]), RESPONSE)),
      coin: o.coin ?? (async (coin, w) => (calls.push([coin, w]), DETAIL)),
    }),
    agents,
    latestRecord: async () => RECORD,
    isGuest: () => o.guest ?? false,
  });
  return { app: new Hono().route("/moves", routes), calls };
}

const triage = (o: Record<string, unknown> = {}) => ({ state: "ok", reason: null, day: "2026-11-10", budget: 8, surfaced: 0, overBudget: 0, watched: 7, agentRuns: 0, agentCap: 6, agentBlockedReason: null, items: [], ...o });

describe("/moves routes", () => {
  test("GET /moves: default window 24h, parsed answer, the agents layer from the triage endpoint", async () => {
    const { app: a, calls } = app({ triage: triage({ agentBlockedReason: "no LLM provider configured" }) });
    const res = await a.request("/moves");
    expect(res.status).toBe(200);
    const body = MovesResponseSchema.parse(await res.json());
    expect(calls).toEqual([["universe", "24h"]]);
    expect(body.layers.agents).toEqual({ state: "partial", reason: "investigations blocked: no LLM provider configured" });
    expect(body.layers.flow).toEqual(RESPONSE.layers.flow);
  });

  test("400 with the field on a bad window or coin", async () => {
    const { app: a } = app();
    for (const path of ["/moves?window=1h", "/moves/COIN?window=7d"]) {
      const res = await a.request(path);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ field: "window" });
    }
    const bad = await a.request("/moves/xyz:TSLA");
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ field: "coin" });
  });

  test("GET /moves/:coin signed in: headlines and the latest agent record", async () => {
    const { app: a, calls } = app({ triage: triage() });
    const d = MoveDetailSchema.parse(await (await a.request("/moves/coin?window=72h")).json());
    expect(calls).toEqual([["coin", "72h"]]);
    expect(d.headlines.length).toBeGreaterThan(0);
    expect(d.record).toEqual(RECORD);
    expect(d.layers.agents).toEqual({ state: "ok", reason: null });
  });

  test("a PUBLIC_MODE guest gets the numbers but no headlines and no record", async () => {
    const { app: a } = app({ guest: true, triage: triage() });
    const d = MoveDetailSchema.parse(await (await a.request("/moves/COIN")).json());
    expect(d.attribution).toEqual(DETAIL.attribution);
    expect(d.headlines).toEqual([]);
    expect(d.record).toBeNull();
  });

  test("the agent routes are mounted before /:coin; an unknown coin is 404", async () => {
    const { app: a, calls } = app({ coin: async (c) => { throw new UnknownCoinError(c); } });
    expect(await (await a.request("/moves/records")).json()).toEqual({ records: [] });
    expect(calls).toEqual([]);
    const res = await a.request("/moves/NOPE");
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ field: "coin" });
  });

  test("layer reasons with no database and no scanner pass through; agents unavailable when the triage endpoint fails", async () => {
    const offline: MovesResponse = {
      ...RESPONSE,
      layers: {
        ...RESPONSE.layers,
        flow: { state: "unavailable", reason: "needs the always-on scanner (OI snapshots)" },
        attention: { state: "unavailable", reason: "needs a database (news and Elfa are stored)" },
        liq: { state: "unavailable", reason: "needs the always-on scanner and crawler" },
      },
    };
    const { app: a } = app({ universe: async () => offline });
    const body = MovesResponseSchema.parse(await (await a.request("/moves?window=4h")).json());
    expect(body.layers).toMatchObject({
      flow: offline.layers.flow, attention: offline.layers.attention, liq: offline.layers.liq,
      agents: { state: "unavailable", reason: "agent watch not available" },
    });
  });

  test("a service failure is a generic 500, never a stack", async () => {
    const { app: a } = app({ universe: async () => { throw new Error("connect ECONNREFUSED postgres://secret"); } });
    const res = await a.request("/moves");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "moves unavailable" });
  });

  test("agentsLayer maps the triage state", () => {
    expect(agentsLayer(triage({ state: "unavailable", reason: "needs the always-on server; or run `bun start`" }) as never)).toEqual({ state: "unavailable", reason: "needs the always-on server; or run `bun start`" });
    expect(agentsLayer(null).state).toBe("unavailable");
  });
});
