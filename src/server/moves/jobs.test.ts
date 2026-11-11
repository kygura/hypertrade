import { describe, expect, test } from "bun:test";
import type { MoveDetail, MoveRow, MovesResponse } from "../../shared/moves.js";
import { MovesResponseSchema } from "../../shared/moves.js";
import { SectorsDataSchema } from "../../shared/schemas.js";
import type { AssetCtx, Candle } from "../../shared/types.js";
import { EmitProvider, llmDeps } from "../intel/fixtures/emit-provider.js";
import { memoSeries } from "../platform/replaySource.js";
import { MemoryPlatformStore } from "../platform/store-memory.js";
import { attribution, detail, iso, record, row, T0 } from "./agent.fixture.js";
import { NO_PROVIDER, type AgentOutput } from "./agent.js";
import { createAgentLoop, type AgentLoopDeps } from "./agentLoop.js";
import { FIXTURE_SECTORS, fixtureSet } from "./fixtures/series.js";
import { movesJobService, runMovesAgentJob, runMovesJob, type MovesAgentJobDeps } from "./jobs.js";
import type { MovesDeps } from "./service.js";

const H = 3_600_000;
const MIN = 60_000;

// ---------------------------------------------------------------- runMovesJob

const fx = fixtureSet();
const ctx = (name: string, i: number): AssetCtx => ({
  name, szDecimals: 2, markPx: fx.candles[name]!.at(-1)!.c, oraclePx: 1, midPx: 1, dayNtlVlm: 1e9 - i * 1e6, prevDayPx: 1, openInterest: 1e6, funding: 0.00001, premium: 0.0001, dayChange: 0, isDelisted: false,
});
const CTXS = Object.keys(fx.candles).map(ctx);

/** Fixture moves deps on a clock that `perFetchMs` moves on at each candle fetch (no network). */
function movesBase(perFetchMs = 0) {
  const clock = { now: fx.asOf + 5 * MIN };
  const fetched: string[] = [];
  const base: MovesDeps = {
    candles: memoSeries(async (coin: string, s: number, e: number): Promise<Candle[]> => {
      fetched.push(coin);
      clock.now += perFetchMs;
      return (fx.candles[coin] ?? []).filter((c) => c.t >= s && c.t <= e);
    }),
    funding: async () => [],
    ctxs: async () => CTXS,
    platform: () => null,
    intel: () => null,
    social: async () => new Map(),
    stages: async () => new Map(),
    sectors: () => SectorsDataSchema.parse(FIXTURE_SECTORS),
    now: () => clock.now,
    serverless: true, // the job's service runs regardless (movesJobService forces it off)
    mine: [],
  };
  return { base, clock, fetched };
}

describe("runMovesJob", () => {
  test("one run, three windows saved as the latest per window, with the facts", async () => {
    const { base, clock, fetched } = movesBase();
    const store = new MemoryPlatformStore();
    const deadline = clock.now + 200_000;
    let weight = 100;
    const r = await runMovesJob({ service: movesJobService(deadline, base), store, now: () => clock.now, deadline, weight: () => (weight += 24) });
    expect(r).toMatchObject({ ok: true, asOf: iso(fx.asOf), saved: ["4h", "24h", "72h"], notSaved: [], coins: 7, dropped: 0, weight: 24 });
    expect(fetched).toHaveLength(7); // one load serves the three windows
    for (const w of ["4h", "24h", "72h"] as const) {
      const run = MovesResponseSchema.parse(await store.latestMovesRun(w));
      expect(run).toMatchObject({ state: "ok", window: w, asOf: iso(fx.asOf) });
      expect(run.rows).toHaveLength(7);
    }
  });

  test("the deadline: no coin fetch starts after deadline − reserve (dropped and named), no window after the deadline", async () => {
    // Each fetch takes 1 min of clock; the load deadline falls after the 4th coin.
    const { base, clock, fetched } = movesBase(MIN);
    const store = new MemoryPlatformStore();
    const deadline = clock.now + 50_000 + 4 * MIN; // MOVES_WINDOWS_RESERVE_MS = 50 s
    const r = await runMovesJob({ service: movesJobService(deadline, base), store, now: () => clock.now, deadline });
    expect(fetched).toEqual(["BTC", "ETH", "COIN", "P1"]);
    expect(r.saved).toEqual(["4h", "24h", "72h"]); // the loaded part is complete: saved
    expect(r).toMatchObject({ coins: 4, dropped: 3 });
    expect(r.droppedSample).toEqual(["P2", "P3", "P4"].map((coin) => ({ coin, reason: "not loaded before the job deadline" })));
    expect((await store.latestMovesRun("24h"))!.universe.dropped.map((d) => d.coin)).toEqual(["P2", "P3", "P4"]);

    // A run that ends past the deadline saves the windows it reached and names the rest.
    const late = movesBase(MIN);
    const store2 = new MemoryPlatformStore();
    const d2 = late.clock.now + 7 * MIN; // the load (7 fetches) ends exactly at the deadline
    const svc = movesJobService(d2 + 60 * MIN, late.base); // the service itself is not cut short
    const r2 = await runMovesJob({ service: svc, store: store2, now: () => late.clock.now, deadline: d2 });
    expect(r2.saved).toEqual(["4h"]);
    expect(r2.notSaved).toEqual([
      { window: "24h", reason: "job deadline reached before this window" },
      { window: "72h", reason: "job deadline reached before this window" },
    ]);
    expect(r2.ok).toBe(false);
    expect(await store2.latestMovesRun("24h")).toBeNull();
  });

  test("a run that fails saves nothing and says why", async () => {
    const { base, clock } = movesBase();
    const store = new MemoryPlatformStore();
    const r = await runMovesJob({ service: movesJobService(clock.now + 200_000, { ...base, candles: async () => Promise.reject(new Error("HL 500")) }), store, now: () => clock.now, deadline: clock.now + 200_000 });
    expect(r.saved).toEqual([]);
    expect(r.notSaved.map((x) => x.window)).toEqual(["4h", "24h", "72h"]);
    expect(r.notSaved[0]!.reason).toContain("moves run failed");
    expect(await store.latestMovesRun("4h")).toBeNull();
  });
});

// ---------------------------------------------------------------- runMovesAgentJob

const out: AgentOutput = { claim: "No public cause beyond the residual.", layer: "unexplained", direction: "long", assets: [], falsifierLevel: null, falsifierText: "", sources: [] };
const ROWS = [row("BTC", { mark: 60000, attribution: null }), row("SOL", { attribution: attribution({ residualZ: 4 }) }), row("WIF", { attribution: attribution({ residualZ: 3 }) }), row("PEPE", { attribution: attribution({ residualZ: 3.5, newsHours: 2 }) })];

function run(rows = ROWS, computedAt = T0 - 10 * MIN): MovesResponse {
  const ok = { state: "ok" as const, reason: null };
  return {
    state: "ok", reason: null, asOf: iso(T0 - H), computedAt: iso(computedAt), window: "24h", progress: null,
    universe: { coins: rows.length, dropped: [] }, sectorsAsOf: null, factors: [], layers: { beta: ok, flow: ok, attention: ok, liq: ok, agents: ok }, rows,
  };
}

function agentSetup(o: { provider?: boolean; clock?: number; budget?: number } = {}) {
  const store = new MemoryPlatformStore();
  const provider = new EmitProvider(() => out);
  const now = () => new Date(o.clock ?? T0);
  const coinCalls: string[] = [];
  let ids = 0;
  const deps: MovesAgentJobDeps = {
    store,
    coin: async (coin): Promise<MoveDetail> => (coinCalls.push(coin), detail(coin, { mark: ROWS.find((r) => r.coin === coin)!.mark })),
    agent: { llm: o.provider === false ? null : llmDeps(provider, undefined, now), now, dailyCap: 6, inflight: new Set(), newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}` },
    budget: o.budget ?? 8,
    mark: async (c) => (c === "BTC" ? 60000 : 10),
    candles: async () => [],
    deadline: (o.clock ?? T0) + 200_000,
  };
  return { store, deps, provider, coinCalls };
}

describe("runMovesAgentJob", () => {
  test("triages the stored run, grades, and runs at most one investigation", async () => {
    const { store, deps, provider, coinCalls } = agentSetup();
    await store.saveMovesRun(run());
    await store.insertAgentRecord(record({ id: "dn", createdAt: iso(T0 - 25 * H), direction: null, falsifier: null }));
    const r = await runMovesAgentJob(deps);
    expect(r).toMatchObject({ surfaced: 3, graded: 1, investigated: "SOL", error: null, scan: { state: "ok", watched: 4, overBudget: 0 } });
    // The response states the stored record (facts only), not null.
    const [sol] = await store.listAgentRecords({ coin: "SOL", limit: 1 });
    expect(r.investigation).toBe(`record ${sol!.id} · ${sol!.status}`);
    expect((await store.listTriage("2026-11-11")).map((i) => i.coin)).toEqual(["SOL", "PEPE", "WIF"]);
    expect(coinCalls).toEqual(["SOL"]); // WIF also qualifies: one per invocation
    expect(provider.prompts).toHaveLength(1);
    expect(await store.loadTriageScan()).toEqual(r.scan);
    // The next call investigates the next one; nothing is surfaced twice.
    const r2 = await runMovesAgentJob(deps);
    expect(r2).toMatchObject({ surfaced: 0, investigated: "WIF" });
  });

  test("without a provider: triage and grading still run, no investigation and no record is written", async () => {
    const { store, deps, coinCalls } = agentSetup({ provider: false });
    await store.saveMovesRun(run());
    await store.insertAgentRecord(record({ id: "dn", createdAt: iso(T0 - 25 * H), direction: null, falsifier: null }));
    const r = await runMovesAgentJob(deps);
    expect(r).toMatchObject({ surfaced: 3, graded: 1, investigated: null, investigation: NO_PROVIDER });
    expect(coinCalls).toEqual([]);
    expect((await store.listAgentRecords({ limit: 5 })).map((x) => x.id)).toEqual(["dn"]);
  });

  test("no stored run, or a stale one: nothing is triaged, grading still runs, the pass says why", async () => {
    const empty = agentSetup();
    expect(await runMovesAgentJob(empty.deps)).toMatchObject({ surfaced: 0, investigated: null, scan: { state: "unavailable", reason: "no moves run stored yet" } });

    const stale = agentSetup();
    await stale.store.saveMovesRun(run(ROWS, T0 - 3 * H));
    const r = await runMovesAgentJob(stale.deps);
    expect(r).toMatchObject({ surfaced: 0, investigated: null, investigation: "no fresh moves run to triage", scan: { state: "unavailable" } });
    expect(r.scan.reason).toBe("latest moves run is 3.0 h old (as of 2026-11-11T11:00:00.000Z); runs are expected hourly");
    expect(await stale.store.listTriage("2026-11-11")).toEqual([]);
  });

  test("unknown news (no feed ingested): the residual surfaces as `news unknown` and nothing is auto-investigated", async () => {
    const { store, deps, coinCalls } = agentSetup();
    const unknown = (r: MoveRow) => (r.attribution ? { ...r, attribution: { ...r.attribution, newsHours: null, residualNewsPct: null } } : r);
    await store.saveMovesRun(run(ROWS.map(unknown)));
    const r = await runMovesAgentJob(deps);
    expect(r).toMatchObject({ surfaced: 3, investigated: null, investigation: "no surfaced no-news residual without a record (news unknown for 3 residual candidates: no auto-investigation without a news feed)" });
    expect((await store.listTriage("2026-11-11")).map((i) => i.reason)).toEqual(["residual +6.2% · z +4.0 · 24h · news unknown", "residual +6.2% · z +3.5 · 24h · news unknown", "residual +6.2% · z +3.0 · 24h · news unknown"]);
    expect(coinCalls).toEqual([]);
  });

  test("no investigation starts without time for its own deadline", async () => {
    const { store, deps, coinCalls } = agentSetup();
    await store.saveMovesRun(run());
    const r = await runMovesAgentJob({ ...deps, deadline: T0 + 30_000 });
    expect(r).toMatchObject({ surfaced: 3, investigated: null, investigation: "not enough time left for an investigation" });
    expect(coinCalls).toEqual([]);
  });

  test("parity: the always-on loop over the in-process run and the job over the stored run make the same triage decisions", async () => {
    const r = run();
    // Loop: the in-process service answers the run.
    const a = agentSetup({ budget: 2 });
    const loopDeps: AgentLoopDeps = { ...a.deps, moves: { universe: async () => r, coin: a.deps.coin } };
    const loopPass = await createAgentLoop(loopDeps).pass(new Date(T0));
    // Job: the same run, stored.
    const b = agentSetup({ budget: 2 });
    await b.store.saveMovesRun(r);
    const jobPass = await runMovesAgentJob(b.deps);
    const strip = (x: typeof loopPass) => ({ ...x, ms: undefined });
    expect(strip({ ...jobPass })).toEqual(strip(loopPass));
    const items = async (s: MemoryPlatformStore) => (await s.listTriage("2026-11-11")).map(({ recordId, ...i }) => ({ ...i, linked: recordId !== null }));
    expect(await items(b.store)).toEqual(await items(a.store));
    expect((await items(a.store)).map((i) => i.coin)).toEqual(["SOL", "PEPE"]);
    expect(await b.store.loadTriageScan()).toEqual(await a.store.loadTriageScan());
  });
});
