import { describe, expect, test } from "bun:test";
import type { SnapshotRow } from "../../shared/intel.js";
import { mapperDeps, position } from "./fixtures/mapper-deps.js";
import { FLOW_ACTIVE_SETTING, flowAlerts, type FlowDeps } from "./flowEvents.js";
import type { MemoryIntelStore } from "./store.js";

const H = 3_600_000;
const NOW = new Date("2026-10-14T12:00:00Z");
const rnd = (i: number) => Math.abs((Math.sin(i * 12.9898 + 78.233) * 43758.5453) % 1);

const snap = (asset: string, t: number, depth: number): SnapshotRow => ({
  asset, ts: new Date(t).toISOString(), price: 100, vol24h: null, funding: null, oiUsd: null, premium: null, basis: null,
  depthBid1: null, depthAsk1: null, depthBid2: depth / 2, depthAsk2: depth / 2, spreadBps: null,
});

/** Hourly snapshots over 5 days with ±10% depth around 1M; the one at `now` is `last`. */
async function depthHistory(store: MemoryIntelStore, asset: string, last: number) {
  const rows: SnapshotRow[] = [];
  for (let i = 120; i >= 1; i--) rows.push(snap(asset, NOW.getTime() - i * H, 1e6 * (0.9 + 0.2 * rnd(i))));
  rows.push(snap(asset, NOW.getTime(), last));
  await store.insertSnapshots(rows);
}

function setup(o: { env?: Record<string, string>; watched?: string[] } = {}) {
  const clock = { now: NOW };
  const base = mapperDeps({ provider: null, positions: [position("SOL", "long", 10_000)], watched: o.watched ?? [], clock });
  const deps: FlowDeps = { ...base, env: o.env ?? {} };
  return { deps, store: base.store, notifier: base.notifier, clock };
}

describe("flowAlerts", () => {
  test("a snapshot detector hit → observed data event + push alert (score × exposure × stop proximity)", async () => {
    const { deps, store, notifier } = setup({ watched: ["ETH"] });
    await depthHistory(store, "SOL", 4e5);
    await depthHistory(store, "ETH", 4e5);
    const r = await flowAlerts(deps, NOW);
    expect(r.errors).toEqual([]);
    expect(r.events.map((e) => e.title).sort()).toEqual(["liquidity_thinning ETH (1h)", "liquidity_thinning SOL (1h)"]);
    const sol = r.events.find((e) => e.assets[0] === "SOL")!;
    expect(sol).toMatchObject({ type: "data", origin: "flow", tag: "observed", sources: [{ label: "snapshot", url: "/markets/SOL" }] });
    expect(sol.flag).toMatchObject({ kind: "detector", name: "liquidity_thinning", asset: "SOL", degraded: false });
    expect(sol.flag!.score).toBeGreaterThan(3);

    const solAlert = r.alerts.find((a) => a.asset === "SOL")!;
    expect(solAlert).toMatchObject({ kind: "flow", ref: sol.id, eventType: "liquidity_thinning", route: "push", hops: 0 });
    expect(solAlert.materiality).toBeCloseTo(sol.flag!.score, 9); // weight 1, no stop
    expect(solAlert.line).toMatchObject({ tag: "observed", source: { label: "snapshot" }, ts: sol.flag!.ts });
    expect(solAlert.line.text).toStartWith("Long SOL: liquidity thinning (1h) · depth_2 ");
    // Watch-only ETH: exposure floor 0.05 keeps it under the push threshold → batched for the brief.
    expect(r.alerts.find((a) => a.asset === "ETH")).toMatchObject({ route: "batch" });
    expect(notifier.sent).toHaveLength(1);
    expect(notifier.sent[0]!.title).toBe("Long SOL: liquidity thinning");
    expect(notifier.sent[0]!.actions).toEqual([
      { label: "👍", data: `fb:${solAlert.id}:1` },
      { label: "👎", data: `fb:${solAlert.id}:-1` },
    ]);
    expect((await store.listAlerts({ route: "batch", limit: 10 })).map((a) => a.asset)).toEqual(["ETH"]);
  });

  test("one event per (detector, asset) until its conditions clear", async () => {
    const { deps, store, clock } = setup();
    await depthHistory(store, "SOL", 4e5);
    expect((await flowAlerts(deps, NOW)).alerts).toHaveLength(1);
    expect((await flowAlerts(deps, NOW)).alerts).toHaveLength(0); // still firing: no repeat
    expect(Object.keys((await store.getSetting<Record<string, string>>(FLOW_ACTIVE_SETTING))!)).toEqual(["liquidity_thinning|SOL"]);

    const t1 = new Date(NOW.getTime() + H);
    clock.now = t1;
    await store.insertSnapshots([snap("SOL", t1.getTime(), 1e6)]);
    expect((await flowAlerts(deps, t1)).alerts).toHaveLength(0); // cleared
    expect(await store.getSetting<Record<string, string>>(FLOW_ACTIVE_SETTING)).toEqual({});

    const t2 = new Date(NOW.getTime() + 2 * H);
    clock.now = t2;
    await store.insertSnapshots([snap("SOL", t2.getTime(), 3e5)]);
    const again = await flowAlerts(deps, t2);
    expect(again.alerts).toHaveLength(1); // a new episode
    expect(again.events[0]!.firstSeen).toBe(t2.toISOString());
  });

  test("a crossing on a venue metric is sourced to the flow provider and venue", async () => {
    const { deps, store } = setup({ env: { INTEL_THRESHOLDS: "long_short_ratio>2" } });
    await store.insertFlow([
      { asset: "SOL", venue: "agg", metric: "long_short_ratio", value: 1.5, ts: new Date(NOW.getTime() - H).toISOString() },
      { asset: "SOL", venue: "agg", metric: "long_short_ratio", value: 2.5, ts: NOW.toISOString() },
    ]);
    const r = await flowAlerts(deps, NOW);
    expect(r.events).toHaveLength(1);
    expect(r.events[0]).toMatchObject({ sources: [{ label: "coinalyze:agg", url: "/asset/SOL" }], flag: { kind: "crossing", name: "long_short_ratio>2", window: "1h", numbers: { from: 1.5, to: 2.5, threshold: 2 } } });
    expect(r.alerts[0]!.line).toMatchObject({ tag: "observed", source: { label: "coinalyze:agg" } });
    expect(r.alerts[0]!.materiality).toBe(0); // no z yet (too few samples) → score 0 → batched
    expect(r.alerts[0]!.route).toBe("batch");
  });

  test("nothing stored: quiet, degraded detectors never become events", async () => {
    const { deps, store } = setup();
    expect(await flowAlerts(deps, NOW)).toEqual({ events: [], alerts: [], errors: [] });
    expect(await store.listEvents({ limit: 10 })).toEqual([]);
  });
});
