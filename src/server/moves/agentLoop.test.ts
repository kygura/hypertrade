import { describe, expect, test } from "bun:test";
import type { MoveDetail, MovesResponse } from "../../shared/moves.js";
import type { Candle } from "../../shared/types.js";
import { EmitProvider, llmDeps } from "../intel/fixtures/emit-provider.js";
import { MemoryPlatformStore } from "../platform/store-memory.js";
import { attribution, detail, iso, record, row, T0 } from "./agent.fixture.js";
import type { AgentOutput } from "./agent.js";
import { createAgentLoop, latestTriageScan, lastCloseBefore, type AgentLoopDeps } from "./agentLoop.js";

const H = 3_600_000;
const out: AgentOutput = { claim: "No public cause beyond the residual.", layer: "unexplained", direction: "long", assets: [], falsifierLevel: null, falsifierText: "", sources: [] };

function universe(rows: MovesResponse["rows"], state: MovesResponse["state"] = "ok"): MovesResponse {
  const ok = { state: "ok" as const, reason: null };
  return {
    state, reason: state === "ok" ? null : "first run", asOf: iso(T0), computedAt: iso(T0), window: "24h", progress: null,
    universe: { coins: rows.length, dropped: [] }, sectorsAsOf: null, factors: [], layers: { beta: ok, flow: ok, attention: ok, liq: ok, agents: ok }, rows,
  };
}

function setup(o: { rows?: MovesResponse["rows"]; state?: MovesResponse["state"]; cap?: number; budget?: number; now?: () => number; candles?: AgentLoopDeps["candles"]; mark?: AgentLoopDeps["mark"] } = {}) {
  const store = new MemoryPlatformStore();
  const provider = new EmitProvider(() => out);
  let clock = T0;
  const now = o.now ?? (() => clock);
  const rows = o.rows ?? [row("BTC", { mark: 60000, attribution: null }), row("SOL", { attribution: attribution({ residualZ: 4 }) }), row("WIF", { attribution: attribution({ residualZ: 3 }) }), row("PEPE", { attribution: attribution({ residualZ: 3.5, newsHours: 2 }) })];
  const coinCalls: string[] = [];
  const deps: AgentLoopDeps = {
    store,
    moves: {
      universe: async () => universe(rows, o.state),
      coin: async (coin): Promise<MoveDetail> => (coinCalls.push(coin), detail(coin, { mark: rows.find((r) => r.coin === coin)!.mark })),
    },
    agent: { llm: llmDeps(provider, undefined, () => new Date(now())), now: () => new Date(now()), dailyCap: o.cap ?? 6, inflight: new Set() },
    budget: o.budget ?? 8,
    mark: o.mark ?? (async (c) => (c === "BTC" ? 60000 : 10)),
    candles: o.candles ?? (async () => []),
  };
  return { store, deps, loop: createAgentLoop(deps), provider, coinCalls, tick: (ms: number) => (clock = ms) };
}

describe("moves-agent loop", () => {
  test("surfaces the day's queue, investigates one no-news residual per tick, links the record", async () => {
    const { store, loop, coinCalls, provider, tick } = setup({ budget: 2 });
    await loop.tick();
    const items = await store.listTriage("2026-11-11");
    expect(items.map((i) => i.coin)).toEqual(["SOL", "PEPE"]); // budget 2: WIF over budget
    expect(latestTriageScan()).toMatchObject({ day: "2026-11-11", state: "ok", watched: 4, overBudget: 1 });
    expect(coinCalls).toEqual(["SOL"]);
    expect(provider.prompts).toHaveLength(1);
    const [rec] = await store.listAgentRecords({ limit: 5 });
    expect(rec).toMatchObject({ coin: "SOL", trigger: "triage", status: "open", inputs: { btcAtCreate: 60000 } });
    expect(items[0]!.recordId).toBe(rec!.id);

    // Next tick: PEPE has news, so nothing new is investigated and nothing is surfaced twice.
    tick(T0 + 15 * 60_000);
    await loop.tick();
    expect(coinCalls).toEqual(["SOL"]);
    expect((await store.listTriage("2026-11-11")).map((i) => i.coin)).toEqual(["SOL", "PEPE"]);
  });

  test("the cap counted from the store stops auto investigations (a restart with the same store keeps it)", async () => {
    const { store, deps, coinCalls } = setup({ cap: 1 });
    await createAgentLoop(deps).tick();
    expect(coinCalls).toEqual(["SOL"]);
    // A fresh loop over the same store (as after a restart on Postgres): budget and cap carry over.
    await createAgentLoop({ ...deps, agent: { ...deps.agent, inflight: new Set() } }).tick();
    expect(coinCalls).toEqual(["SOL"]);
    expect(await store.listAgentRecords({ status: "capped", limit: 5 })).toEqual([]); // auto never writes capped rows
  });

  test("grading runs when the moves service is still loading", async () => {
    const { store, loop, coinCalls } = setup({ state: "pending" });
    await store.insertAgentRecord(record({ id: "dn", createdAt: iso(T0 - 25 * H), direction: null, falsifier: null }));
    await loop.tick();
    expect(latestTriageScan()).toMatchObject({ state: "pending", reason: "first run" });
    expect(coinCalls).toEqual([]);
    expect((await store.listAgentRecords({ limit: 5 }))[0]).toMatchObject({ id: "dn", status: "graded", grade: null });
  });

  test("grades at the horizon on the mark vs BTC, falsifies on an hourly low, closes stale in-flight calls", async () => {
    const created = T0 - 24 * H;
    const candles = async (coin: string, s: number, e: number): Promise<Candle[]> => {
      const px = coin === "BTC" ? 60000 : coin === "SOL" ? 100 : 50;
      const cs: Candle[] = [];
      for (let t = Math.ceil(s / H) * H; t + H <= e; t += H) {
        const low = coin === "ETH" && t === created + 3 * H ? 44 : px * 0.99;
        cs.push({ t, T: t + H - 1, o: px, h: px * 1.01, l: low, c: px, v: 1, n: 1, s: coin, i: "1h" } as Candle);
      }
      return cs;
    };
    const mark = async (c: string) => (c === "BTC" ? 61200 : c === "SOL" ? 104 : 50);
    const { store, loop } = setup({ rows: [], candles, mark });
    await store.insertAgentRecord(record({ id: "due", coin: "SOL", createdAt: iso(created) }));
    await store.insertAgentRecord(record({ id: "fals", coin: "ETH", createdAt: iso(created + 2 * H), inputs: { ...record().inputs, markAtCreate: 50 }, falsifier: { level: 45, side: "below", text: "" } }));
    await store.insertAgentRecord(record({ id: "stale", coin: "WIF", createdAt: iso(T0 - H), claim: "", direction: null, falsifier: null }));
    await loop.tick();
    const by = Object.fromEntries((await store.listAgentRecords({ limit: 5 })).map((r) => [r.id, r]));
    expect(by.due).toMatchObject({ status: "graded", grade: { px: 104, btcPx: 61200, hit: true, falsifiedAt: null } });
    expect(by.due!.grade!.relPct).toBeCloseTo(100 * (Math.log(1.04) - Math.log(1.02)), 10);
    expect(by.fals).toMatchObject({ status: "falsified", grade: { px: 45, hit: false, falsifiedAt: iso(created + 3 * H) } });
    expect(by.stale).toMatchObject({ status: "failed", error: expect.stringContaining("never finished") });
  });

  test("lastCloseBefore takes the last full hour before the horizon", () => {
    const bars = [0, 1, 2].map((i) => ({ t: T0 + i * H, h: 1, l: 1, c: i + 1 }));
    expect(lastCloseBefore(bars, T0 + 2 * H + 30 * 60_000)).toBe(2);
    expect(lastCloseBefore(bars, T0)).toBeNull();
  });
});
