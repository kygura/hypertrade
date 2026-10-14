import { describe, expect, test } from "bun:test";
import type { SnapshotRow } from "../../shared/intel.js";
import { addManualCatalyst, catalystAlerts } from "./catalysts.js";
import { flowAlerts } from "./flowEvents.js";
import { mapperDeps, position } from "./fixtures/mapper-deps.js";
import { routeEntities, type RouteInput } from "./mapper.js";
import type { MemoryIntelStore, NewAlert } from "./store.js";

// Store-backed wiring of confluence (SPEC.md § Scout S0.6): the source classes
// active on an asset in the last 6 h lift the materiality of a new alert.

const H = 3_600_000;
const NOW = new Date("2026-10-14T12:00:00Z");

const priorAlert = (kind: NewAlert["kind"], eventType: string, ref: string): NewAlert => ({
  kind, ref, window: null, asset: "SOL", title: "prior", eventType,
  line: { tag: "hypothesis", text: "Long SOL: prior." }, path: [], edgeType: null, hops: 0, pathWeight: 1,
  sources: [], materiality: 0.2, pricedIn: null, route: "batch",
});

const exploit: RouteInput = {
  kind: "mapper", ref: "cluster-x", entities: ["SOL"], eventType: "exploit", magnitude: "med", title: "SOL exploit",
  sources: [{ label: "rss", url: "https://news.example.com/a" }], firstSeen: NOW.toISOString(), explain: false,
};

function setup() {
  const clock = { now: NOW };
  const deps = mapperDeps({ provider: null, clock, positions: [position("SOL", "long", 10_000)] });
  /** Stores a prior alert `agoH` hours back. */
  const seed = async (agoH: number, kind: NewAlert["kind"], eventType: string, ref: string) => {
    clock.now = new Date(NOW.getTime() - agoH * H);
    await deps.store.insertAlert(priorAlert(kind, eventType, ref));
    clock.now = NOW;
  };
  return { deps, seed, clock };
}

const mapperMateriality = async (deps: ReturnType<typeof setup>["deps"]) => (await routeEntities(deps, exploit)).alerts[0]!.materiality;

describe("confluence wiring", () => {
  test("mapper: a flow alert inside the window lifts materiality 1.25×; outside it, or alone, 1.0×", async () => {
    const lone = setup();
    const base = await mapperMateriality(lone.deps);
    expect(base).toBeGreaterThan(0);

    const inside = setup();
    await inside.seed(1, "flow", "crowded_long", "f1");
    expect(await mapperMateriality(inside.deps)).toBeCloseTo(base * 1.25, 9);

    const outside = setup();
    await outside.seed(7, "flow", "crowded_long", "f1");
    expect(await mapperMateriality(outside.deps)).toBeCloseTo(base, 9);
  });

  test("mapper: its own source (another news alert) does not boost it", async () => {
    const base = await mapperMateriality(setup().deps);
    const s = setup();
    await s.seed(1, "mapper", "exploit", "older-news");
    expect(await mapperMateriality(s.deps)).toBeCloseTo(base, 9);
  });

  test("catalysts: own source (news) excluded, a flow alert counts", async () => {
    const run = async (prior?: { kind: NewAlert["kind"]; eventType: string }) => {
      const s = setup();
      if (prior) await s.seed(1, prior.kind, prior.eventType, "p1");
      await addManualCatalyst(s.deps.store, { title: "SOL unlock", assets: ["SOL"], scheduledAt: new Date(NOW.getTime() + 20 * H).toISOString(), type: "unlock" }, NOW);
      const { alerts } = await catalystAlerts(s.deps, NOW);
      return alerts.find((a) => a.kind === "catalyst")!.materiality;
    };
    const base = await run();
    expect(await run({ kind: "mapper", eventType: "exploit" })).toBeCloseTo(base, 9);
    expect(await run({ kind: "flow", eventType: "crowded_long" })).toBeCloseTo(base * 1.25, 9);
  });
});

describe("flowAlerts confluence symmetry", () => {
  const rnd = (i: number) => Math.abs((Math.sin(i * 12.9898 + 78.233) * 43758.5453) % 1);
  const snap = (t: number, depth: number): SnapshotRow => ({
    asset: "SOL", ts: new Date(t).toISOString(), price: 100, vol24h: null, funding: null, oiUsd: null, premium: null, basis: null,
    depthBid1: null, depthAsk1: null, depthBid2: depth / 2, depthAsk2: depth / 2, spreadBps: null,
  });

  async function run(o: { detector: boolean; regime: boolean }) {
    const clock = { now: NOW };
    const base = mapperDeps({ provider: null, positions: [position("SOL", "long", 10_000)], clock });
    const store: MemoryIntelStore = base.store;
    const rows: SnapshotRow[] = [];
    for (let i = 120; i >= 1; i--) rows.push(snap(NOW.getTime() - i * H, 1e6 * (0.9 + 0.2 * rnd(i))));
    rows.push(snap(NOW.getTime(), o.detector ? 4e5 : 1e6));
    await store.insertSnapshots(rows);
    await store.insertFlow([
      ...Array.from({ length: 119 }, (_, j) => ({ asset: "SOL", venue: "agg", metric: "long_short_ratio" as const, value: 1.2 + 0.4 * rnd(j + 500), ts: new Date(NOW.getTime() - (120 - j) * H).toISOString() })),
      { asset: "SOL", venue: "agg", metric: "long_short_ratio" as const, value: 1.5, ts: new Date(NOW.getTime() - H).toISOString() },
      { asset: "SOL", venue: "agg", metric: "long_short_ratio" as const, value: o.regime ? 2.5 : 1.5, ts: NOW.toISOString() },
    ]);
    const r = await flowAlerts({ ...base, env: { INTEL_THRESHOLDS: "long_short_ratio>2" } }, NOW);
    const m = (name: string) => r.alerts.find((a) => a.eventType === name)?.materiality;
    return { detector: m("liquidity_thinning"), regime: m("long_short_ratio>2") };
  }

  test("a detector and a regime flag in one run both get 1.25× of their solo materiality", async () => {
    const solo = { detector: (await run({ detector: true, regime: false })).detector!, regime: (await run({ detector: false, regime: true })).regime! };
    expect(solo.detector).toBeGreaterThan(0);
    expect(solo.regime).toBeGreaterThan(0);
    const both = await run({ detector: true, regime: true });
    expect(both.detector).toBeCloseTo(solo.detector * 1.25, 9);
    expect(both.regime).toBeCloseTo(solo.regime * 1.25, 9);
  });
});
