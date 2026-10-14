import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { AssetDetailResponseSchema, FlowsResponseSchema, HEATMAP_METRICS, HeatmapResponseSchema, type SnapshotRow } from "../../../shared/intel.js";
import { exposureOf, mapperDeps, position } from "../../intel/fixtures/mapper-deps.js";
import { flowAlerts } from "../../intel/flowEvents.js";
import type { LlmDeps } from "../../intel/llm.js";
import { MemoryIntelStore } from "../../intel/store.js";
import { createIntelRoutes, type IntelDeps } from "./index.js";

const H = 3_600_000;
const NOW = new Date("2026-10-14T12:00:00Z");
const rnd = (i: number) => Math.abs((Math.sin(i * 12.9898 + 78.233) * 43758.5453) % 1);

const snap = (asset: string, t: number, price: number, depth: number): SnapshotRow => ({
  asset, ts: new Date(t).toISOString(), price, vol24h: null, funding: 1e-5, oiUsd: null, premium: null, basis: null,
  depthBid1: null, depthAsk1: null, depthBid2: depth / 2, depthAsk2: depth / 2, spreadBps: null,
});

/** 15-min SOL snapshots over 5 days, noisy price around 100; the last 45 min jump to 110 and depth thins. */
async function seed(store: MemoryIntelStore) {
  const rows: SnapshotRow[] = [];
  for (let i = 5 * 96; i >= 0; i--) {
    const t = NOW.getTime() - i * 15 * 60_000;
    rows.push(snap("SOL", t, i <= 3 ? 110 : 100 * (1 + 0.002 * (rnd(i) - 0.5)), i === 0 ? 3e5 : 1e6 * (0.9 + 0.2 * rnd(i))));
  }
  await store.insertSnapshots(rows);
  await store.insertFlow([{ asset: "SOL", venue: "agg", metric: "liq_long_usd", value: 5e4, ts: NOW.toISOString() }]);
}

function setup(env: Record<string, string> = {}) {
  const store = new MemoryIntelStore(() => NOW);
  const llm: LlmDeps = { makeProvider: () => null, cache: store, now: () => NOW, dailyCap: 200 };
  const positions = [position("SOL", "long", 10_000)];
  const deps = {
    store,
    env: { DESK_WATCHLIST: "", ...env },
    exposure: async () => exposureOf(positions),
    watched: async () => ["ETH"],
    ctxs: async () => [],
    candles1h: async () => [],
    observations: async () => [],
    funding: async () => [],
    ingestHealth: async () => [{ source: "flow:coinalyze", ok: false, lastRunAt: NOW.toISOString(), error: "future-markets: HTTP 401" }],
    llm,
    thresholds: { minZ: 2, topK: 5, pushMateriality: 0.35, digestMateriality: 0.1 },
    now: () => NOW,
  } as unknown as IntelDeps; // journal/thesis/copilot/docwatch are not reached by these routes
  const app = new Hono().basePath("/api").route("/intel", createIntelRoutes(deps));
  const get = async (path: string) => {
    const res = await app.request(`/api/intel${path}`);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  return { store, get, positions };
}

describe("GET /heatmap", () => {
  test("rows by materiality, fixed metric order, per-cell z/Δ, live flags, no_source without a key", async () => {
    const { store, get } = setup();
    await seed(store);
    const { status, body } = await get("/heatmap?window=1h");
    expect(status).toBe(200);
    const h = HeatmapResponseSchema.parse(body);
    expect(h.metrics).toEqual([...HEATMAP_METRICS]);
    expect(h.rows.map((r) => [r.asset, r.held])).toEqual([
      ["SOL", true],
      ["ETH", false],
    ]);
    expect(h.rows[0]!.materiality).toBeGreaterThan(2);
    expect(h.rows[1]!.materiality).toBe(0);
    expect(h.cells).toHaveLength(2 * HEATMAP_METRICS.length);
    const price = h.cells.find((c) => c.asset === "SOL" && c.metric === "price")!;
    expect(price.delta).toBeCloseTo(10, 0);
    expect(price.z!).toBeGreaterThan(2);
    expect(h.cells.find((c) => c.asset === "SOL" && c.metric === "liq_usd")).toMatchObject({ z: null });
    expect(h.cells.filter((c) => c.asset === "ETH").every((c) => c.z === null && c.delta === null)).toBe(true);
    expect(h.flags.find((f) => f.name === "liquidity_thinning")).toMatchObject({ asset: "SOL", degraded: false });
    expect(h.flags.some((f) => f.degraded)).toBe(true);
    expect(h.flow).toEqual({ ok: false, error: "no_source" });
    expect(h.asOf).toBe(NOW.toISOString());
  });

  test("review window = Δ since the last review; key set → last collector run's status; bad window → 400", async () => {
    const { store, get } = setup({ COINALYZE_API_KEY: "k" });
    await seed(store);
    await store.logReview({ via: "ui" }); // at NOW → span floored at 1 h
    const h = HeatmapResponseSchema.parse((await get("/heatmap")).body);
    expect(h.cells.find((c) => c.asset === "SOL" && c.metric === "price")!.delta).toBeCloseTo(10, 0);
    expect(h.flow).toEqual({ ok: false, error: "future-markets: HTTP 401" });
    expect((await get("/heatmap?window=2h")).status).toBe(400);
  });
});

describe("GET /asset/:coin and /flows", () => {
  test("series, events (flow hit, alert, catalyst) ascending, catalysts and graph; flows lists stored flags", async () => {
    const { store, get, positions } = setup();
    await seed(store);
    const base = mapperDeps({ provider: null, store, positions, clock: { now: NOW } });
    const run = await flowAlerts(base, NOW);
    expect(run.events.map((e) => e.flag!.name)).toContain("liquidity_thinning");
    await store.insertAlert({
      kind: "mapper", ref: "c1", window: null, asset: "SOL", title: "Jito exploit", eventType: "exploit",
      line: { tag: "hypothesis", text: "Long SOL. Exposed via Jito." }, path: [], edgeType: null, hops: 0, pathWeight: 1,
      sources: [{ label: "news", url: "https://news.example.net/a" }], materiality: 0.5, pricedIn: null, route: "batch",
    });
    await store.upsertEvents([{
      key: "cat:1", type: "upgrade", title: "SOL upgrade", summary: null, entities: ["SOL"], assets: ["SOL"], magnitude: "med",
      sources: [{ label: "manual" }], origin: "manual", firstSeen: NOW.toISOString(), scheduledAt: new Date(NOW.getTime() + 48 * H).toISOString(), catalyst: null, tag: "hypothesis",
    }]);

    const { status, body } = await get("/asset/SOL?days=2");
    expect(status).toBe(200);
    const a = AssetDetailResponseSchema.parse(body);
    expect(a.snapshots).toHaveLength(2 * 96 + 1);
    expect(a.flow).toEqual([{ asset: "SOL", venue: "agg", metric: "liq_long_usd", value: 5e4, ts: NOW.toISOString() }]);
    expect(a.events.map((e) => e.kind)).toEqual([...run.events.map(() => "flow" as const), "alert" as const, "catalyst" as const]);
    expect(a.events.find((e) => e.kind === "flow")).toMatchObject({ tag: "observed", url: "/markets/SOL", numbers: expect.any(Object) });
    expect(a.events.find((e) => e.kind === "alert")).toMatchObject({ claim: { tag: "hypothesis" }, url: "https://news.example.net/a" });
    expect(a.catalysts).toMatchObject([{ title: "SOL upgrade", exposed: ["SOL"] }]);
    expect(a.graph.edges.length).toBeGreaterThan(0);
    expect(a.graph.edges.every((e) => e.src === "SOL" || e.dst === "SOL")).toBe(true);
    expect((await get("/asset/not a coin")).status).toBe(400);
    expect((await get("/asset/SOL?days=0")).status).toBe(400);

    const flows = FlowsResponseSchema.parse((await get(`/flows?since=${encodeURIComponent(NOW.toISOString())}`)).body);
    expect(flows.flags.map((f) => f.name).sort()).toEqual(run.events.map((e) => e.flag!.name).sort());
    expect(FlowsResponseSchema.parse((await get("/flows?since=2099-01-01T00:00:00Z")).body).flags).toEqual([]);
    expect((await get("/flows?since=yesterday")).status).toBe(400);
  });
});
