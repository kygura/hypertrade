import { describe, expect, test } from "bun:test";
import type { SnapshotRow } from "../../shared/intel.js";
import { MemoryIntelStore, PgIntelStore, type NewAlert, type NewEvent } from "./store.js";

const snap = (asset: string, ts: string, price: number): SnapshotRow => ({
  asset, ts, price, vol24h: null, funding: null, oiUsd: null, premium: null, basis: null,
  depthBid1: null, depthAsk1: null, depthBid2: null, depthAsk2: null, spreadBps: null,
});

const alert = (over: Partial<NewAlert> = {}): NewAlert => ({
  kind: "mapper",
  ref: "cluster-1",
  window: null,
  asset: "SOL",
  title: "Jito exploit",
  eventType: "exploit",
  line: { tag: "hypothesis", text: "Long SOL. LST collateral at risk." },
  path: [{ from: "Jito", to: "SOL", type: "collateral" }],
  edgeType: "collateral",
  hops: 1,
  pathWeight: 0.8,
  sources: [{ label: "rekt.news", url: "https://rekt.news/jito" }],
  materiality: 0.4,
  pricedIn: null,
  route: "push",
  ...over,
});

const event = (key: string, over: Partial<NewEvent> = {}): NewEvent => ({
  key, type: "exploit", title: `t ${key}`, summary: null, entities: [], assets: [], magnitude: "high",
  sources: [], origin: "rss", firstSeen: "2026-10-13T00:00:00.000Z", scheduledAt: null, catalyst: null, tag: "observed", ...over,
});

describe("MemoryIntelStore alerts", () => {
  test("dedupes on (kind, ref, asset, window) and returns null for the duplicate", async () => {
    const s = new MemoryIntelStore();
    const first = await s.insertAlert(alert());
    expect(first).toMatchObject({ kind: "mapper", asset: "SOL", feedback: null, window: null });
    expect(await s.insertAlert(alert({ materiality: 0.9 }))).toBeNull();
    expect(await s.insertAlert(alert({ asset: "JTO" }))).not.toBeNull();
    expect(await s.insertAlert(alert({ kind: "docwatch" }))).not.toBeNull();
    // Catalyst windows are separate alerts for the same event and asset.
    expect(await s.insertAlert(alert({ kind: "catalyst", ref: "ev-1", window: "24h" }))).not.toBeNull();
    expect(await s.insertAlert(alert({ kind: "catalyst", ref: "ev-1", window: "1h" }))).not.toBeNull();
    expect(await s.insertAlert(alert({ kind: "catalyst", ref: "ev-1", window: "1h" }))).toBeNull();
    expect((await s.listAlerts({ limit: 50 })).length).toBe(5);
    expect((await s.listAlerts({ kind: "catalyst", limit: 50 })).length).toBe(2);
  });

  test("aggregates feedback per (event type, edge type, hops), most downvoted first", async () => {
    const s = new MemoryIntelStore();
    const a = (await s.insertAlert(alert({ asset: "A" })))!;
    const b = (await s.insertAlert(alert({ asset: "B" })))!;
    const c = (await s.insertAlert(alert({ asset: "C", eventType: "listing", edgeType: "narrative", hops: 2 })))!;
    const d = (await s.insertAlert(alert({ asset: "D", eventType: "listing", edgeType: "narrative", hops: 2 })))!;
    await s.setAlertFeedback(a.id, 1);
    await s.setAlertFeedback(b.id, -1);
    await s.setAlertFeedback(c.id, 1);
    await s.setAlertFeedback(c.id, -1); // a re-vote replaces the first one
    await s.setAlertFeedback(d.id, -1);
    expect(await s.setAlertFeedback("missing", 1)).toBeNull();
    const stats = await s.feedbackStats();
    expect(stats).toEqual([
      { eventType: "listing", edgeType: "narrative", hops: 2, up: 0, down: 2, total: 2 },
      { eventType: "exploit", edgeType: "collateral", hops: 1, up: 1, down: 1, total: 2 },
    ]);
  });
});

describe("MemoryIntelStore snapshots", () => {
  test("nearest picks the closer side, ties earlier; before/after are inclusive", async () => {
    const s = new MemoryIntelStore();
    await s.insertSnapshots([
      snap("BTC", "2026-10-13T00:00:00.000Z", 1),
      snap("BTC", "2026-10-13T00:15:00.000Z", 2),
      snap("BTC", "2026-10-13T00:30:00.000Z", 3),
      snap("ETH", "2026-10-13T00:20:00.000Z", 9),
    ]);
    const at = (t: string) => new Date(`2026-10-13T${t}Z`);
    expect((await s.nearestSnapshot("BTC", at("00:20:00")))?.price).toBe(2);
    expect((await s.nearestSnapshot("BTC", at("00:25:00")))?.price).toBe(3);
    expect((await s.nearestSnapshot("BTC", at("00:22:30")))?.price).toBe(2);
    expect((await s.nearestSnapshot("BTC", at("00:16:00"), "after"))?.price).toBe(3);
    expect((await s.nearestSnapshot("BTC", at("00:15:00"), "after"))?.price).toBe(2);
    expect((await s.nearestSnapshot("BTC", at("00:29:00"), "before"))?.price).toBe(2);
    expect(await s.nearestSnapshot("BTC", at("00:31:00"), "after")).toBeNull();
    expect((await s.nearestSnapshot("BTC", at("05:00:00")))?.price).toBe(3);
    expect(await s.nearestSnapshot("SOL", at("00:00:00"))).toBeNull();
  });

  test("upserts on (asset, ts), ranges ascending and prunes", async () => {
    const s = new MemoryIntelStore();
    await s.insertSnapshots([snap("BTC", "2026-10-13T00:15:00.000Z", 2), snap("BTC", "2026-10-13T00:00:00.000Z", 1)]);
    await s.insertSnapshots([snap("BTC", "2026-10-13T00:15:00Z", 5)]);
    const range = await s.snapshotRange("BTC", new Date("2026-10-12T00:00:00Z"), new Date("2026-10-14T00:00:00Z"));
    expect(range.map((r) => r.price)).toEqual([1, 5]);
    expect(await s.pruneSnapshots(new Date("2026-10-13T00:10:00Z"))).toBe(1);
    expect((await s.snapshotRange("BTC", new Date(0), new Date("2030-01-01"))).length).toBe(1);
  });
});

// Same rules as PgIntelStore's intel_stops SQL: upsert on (asset, side, ts); stopAt = earliest with from <= ts < before.
describe("MemoryIntelStore stops", () => {
  const at = (t: string) => new Date(`2026-10-13T${t}Z`);
  const stop = (asset: string, side: "long" | "short", t: string, stopPx: number) => ({ asset, side, ts: `2026-10-13T${t}.000Z`, stopPx });

  test("upserts on (asset, side, ts); stopAt is the earliest in [from, before), per side", async () => {
    const s = new MemoryIntelStore();
    expect(
      await s.recordStops([stop("ETH", "long", "01:00:00", 3000), stop("ETH", "long", "01:00:00", 3050), stop("ETH", "long", "02:00:00", 3100), stop("ETH", "short", "00:30:00", 4000)]),
    ).toBe(3);
    expect(await s.stopAt("ETH", "long", at("00:00:00"))).toEqual(stop("ETH", "long", "01:00:00", 3050)); // last of a duplicate key wins
    expect((await s.stopAt("ETH", "long", at("01:00:00")))?.stopPx).toBe(3050); // from is inclusive
    expect((await s.stopAt("ETH", "long", at("01:00:01")))?.stopPx).toBe(3100);
    expect(await s.stopAt("ETH", "long", at("01:00:01"), at("02:00:00"))).toBeNull(); // before is exclusive
    expect((await s.stopAt("ETH", "short", at("00:00:00"), at("01:00:00")))?.stopPx).toBe(4000);
    expect(await s.stopAt("ETH", "short", at("00:31:00"))).toBeNull();
    expect(await s.stopAt("BTC", "long", at("00:00:00"))).toBeNull();
    expect(await s.recordStops([])).toBe(0);
  });

  test("prunes before a cutoff", async () => {
    const s = new MemoryIntelStore();
    await s.recordStops([stop("SOL", "long", "00:00:00", 140), stop("SOL", "long", "06:00:00", 145)]);
    expect(await s.pruneStops(at("03:00:00"))).toBe(1);
    expect((await s.stopAt("SOL", "long", new Date(0)))?.stopPx).toBe(145);
  });
});

describe("MemoryIntelStore graph, events, cache", () => {
  test("user edges survive seed/llm upserts; only user edges delete", async () => {
    const s = new MemoryIntelStore();
    await s.upsertEdges([{ src: "Jito", dst: "SOL", type: "collateral", weight: 0.9, source: null, lastVerified: null, origin: "user" }]);
    expect(await s.upsertEdges([{ src: "Jito", dst: "SOL", type: "collateral", weight: 0.1, source: "https://x.io", lastVerified: null, origin: "llm" }])).toBe(0);
    expect((await s.edgesFor(["SOL"]))[0]).toMatchObject({ weight: 0.9, origin: "user" });
    await s.upsertEdges([{ src: "USDC", dst: "HYPE", type: "settles_on", weight: 0.6, source: "seed", lastVerified: null, origin: "seed" }]);
    expect(await s.deleteUserEdge({ src: "USDC", dst: "HYPE", type: "settles_on" })).toBe(false);
    expect(await s.deleteUserEdge({ src: "Jito", dst: "SOL", type: "collateral" })).toBe(true);
    expect((await s.listEdges()).length).toBe(1);
  });

  test("event upsert keeps id, firstSeen and cluster; last duplicate in a batch wins", async () => {
    const s = new MemoryIntelStore();
    const [e] = await s.upsertEvents([event("k1")]);
    const c = await s.upsertCluster({ label: "Jito", entities: ["Jito"], extraction: null, firstSeen: e!.firstSeen, lastSeen: e!.firstSeen, mappedAt: null });
    await s.setEventCluster([e!.id], c.id);
    const out = await s.upsertEvents([event("k1", { title: "a", firstSeen: "2026-10-14T00:00:00.000Z" }), event("k1", { title: "b" })]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: e!.id, title: "b", firstSeen: "2026-10-13T00:00:00.000Z", clusterId: c.id });
    expect((await s.eventsByCluster(c.id)).map((x) => x.id)).toEqual([e!.id]);
    await s.upsertEvents([event("cat", { origin: "manual", scheduledAt: "2026-10-20T12:00:00.000Z" })]);
    const cats = await s.listCatalysts(new Date("2026-10-13"), new Date("2026-10-27"));
    expect(cats.map((x) => x.key)).toEqual(["cat"]);
    expect(await s.deleteManualEvent(e!.id)).toBe(false);
    expect(await s.deleteManualEvent(cats[0]!.id)).toBe(true);
  });

  test("event scheduledAt is normalized to ISO UTC like firstSeen (offset input)", async () => {
    const s = new MemoryIntelStore();
    const [e] = await s.upsertEvents([event("off", { origin: "manual", firstSeen: "2026-10-13T02:00:00+02:00", scheduledAt: "2026-10-20T14:00:00+02:00" })]);
    expect(e).toMatchObject({ firstSeen: "2026-10-13T00:00:00.000Z", scheduledAt: "2026-10-20T12:00:00.000Z" });
    expect((await s.listCatalysts(new Date("2026-10-20T11:59:00Z"), new Date("2026-10-20T12:01:00Z")))[0]?.scheduledAt).toBe("2026-10-20T12:00:00.000Z");
  });

  test("LLM cache keys on (key, promptVersion) and counts calls since a time", async () => {
    let now = new Date("2026-10-13T00:00:00Z");
    const s = new MemoryIntelStore(() => now);
    await s.cachePut("k", "v1", { a: 1 }, { in: 10 });
    now = new Date("2026-10-13T05:00:00Z");
    await s.cachePut("k", "v2", { a: 2 }, null);
    await s.cachePut("j", "v1", { b: 1 }, null);
    expect(await s.cacheGet("k", "v1")).toEqual({ a: 1 });
    expect(await s.cacheGet("k", "v3")).toBeNull();
    expect(await s.callsSince(new Date("2026-10-13T01:00:00Z"))).toBe(2);
    expect(await s.callsSince(new Date("2026-10-12T00:00:00Z"))).toBe(3);
  });

  test("briefs by surface, reviews, settings and watch changes", async () => {
    const s = new MemoryIntelStore();
    const body = { since: "2026-10-13T00:00:00.000Z", items: [], alerts: [], catalysts: [], lines: [], silent: true };
    await s.insertBrief({ ...body, surface: "cron" });
    const ui = await s.insertBrief({ ...body, surface: "ui" });
    expect((await s.latestBrief())?.id).toBe(ui.id);
    expect((await s.latestBrief("cron"))?.surface).toBe("cron");
    await s.logReview({ via: "ui", briefId: ui.id });
    expect(await s.lastReview()).toMatchObject({ via: "ui", briefId: ui.id });
    await s.setSetting("x", { n: 1 });
    expect(await s.getSetting<{ n: number }>("x")).toEqual({ n: 1 });
    const w = await s.insertWatch({ kind: "evm_wallet", target: "0x" + "b".repeat(40), chain: "base", label: "treasury" });
    const ch = await s.insertWatchChange({ watchId: w.id, fromHash: null, toHash: "h1", diff: null, facts: ["nonce 1 → 2"], detail: null, lines: [] });
    expect(ch.alertedAssets).toEqual([]);
    await s.setWatchChangeAlerted(ch.id, ["ETH"]);
    expect((await s.listWatchChanges(w.id, 10))[0]).toMatchObject({ facts: ["nonce 1 → 2"], alertedAssets: ["ETH"] });
    await expect(s.insertWatchChange({ watchId: "nope", fromHash: null, toHash: "h", diff: null, facts: [], detail: null, lines: [] })).rejects.toThrow();
    expect(await s.deleteWatch(w.id)).toBe(true);
    expect(await s.listWatchChanges(w.id, 10)).toHaveLength(0);
  });
});

// Live Postgres run (store.pg.test.ts): Postgres returns every timestamptz as
// ISO UTC; the memory store echoed the caller's spelling for these fields.
describe("MemoryIntelStore timestamp parity with Postgres", () => {
  test("cluster, edge, brief, thesis and watch timestamps come back as ISO UTC", async () => {
    const s = new MemoryIntelStore();
    const c = await s.upsertCluster({ label: null, entities: [], extraction: null, firstSeen: "2026-10-13T02:00:00+02:00", lastSeen: "2026-10-13T06:00:00+02:00", mappedAt: "2026-10-13T05:00:00Z" });
    expect(c).toMatchObject({ firstSeen: "2026-10-13T00:00:00.000Z", lastSeen: "2026-10-13T04:00:00.000Z", mappedAt: "2026-10-13T05:00:00.000Z" });
    await s.upsertEdges([{ src: "A", dst: "B", type: "direct", weight: 1, source: null, lastVerified: "2026-10-13T02:00:00+02:00", origin: "seed" }]);
    expect((await s.listEdges())[0]!.lastVerified).toBe("2026-10-13T00:00:00.000Z");
    const b = await s.insertBrief({ surface: "ui", since: "2026-10-13T02:00:00+02:00", items: [], alerts: [], catalysts: [], lines: [], silent: true });
    expect(b.since).toBe("2026-10-13T00:00:00.000Z");
    const t = await s.insertThesis({ text: "x", assets: [], claims: [], invalidation: [], wrongIf: [], checkedAt: "2026-10-13T02:00:00+02:00" });
    expect(t.checkedAt).toBe("2026-10-13T00:00:00.000Z");
    expect((await s.updateThesis(t.id, { checkedAt: "2026-10-14T02:00:00+02:00" }))!.checkedAt).toBe("2026-10-14T00:00:00.000Z");
    const w = await s.insertWatch({ kind: "evm_wallet", target: "0x" + "c".repeat(40), chain: "base", label: "w" });
    await s.updateWatchState(w.id, { lastHash: "h", lastSnapshot: null, checkedAt: "2026-10-13T02:00:00+02:00", error: null });
    expect((await s.getWatch(w.id))!.checkedAt).toBe("2026-10-13T00:00:00.000Z");
  });
});

describe("PgIntelStore ids that are not uuids", () => {
  // Postgres rejects them with a cast error (a 500 through any route that
  // passes an id straight through); they read as missing, like the memory
  // store, and no query is sent (DATABASE_URL may be unset here).
  test("read as missing without touching the database", async () => {
    const s = new PgIntelStore();
    const bad = "------------------------------------";
    expect(await s.getManualPosition(bad)).toBeNull();
    expect(await s.updateManualPosition(bad, { asset: "SOL", side: "long", size: 1, entryPx: 1, leverage: 1, venue: "v" })).toBeNull();
    expect(await s.deleteManualPosition("nope")).toBe(false);
    expect(await s.getAlert("nope")).toBeNull();
    expect(await s.setAlertFeedback("nope", 1)).toBeNull();
    expect(await s.getEvent("nope")).toBeNull();
    expect(await s.deleteManualEvent("nope")).toBe(false);
    expect(await s.getCluster("nope")).toBeNull();
    expect(await s.eventsByCluster("nope")).toEqual([]);
    await s.setEventCluster(["nope"], "nope");
    expect(await s.getThesis("nope")).toBeNull();
    expect(await s.updateThesis("nope", { checkedAt: null })).toBeNull();
    expect(await s.deleteThesis("nope")).toBe(false);
    expect(await s.getWatch("nope")).toBeNull();
    await s.updateWatchState("nope", { lastHash: null, lastSnapshot: null, checkedAt: null, error: null });
    expect(await s.deleteWatch("nope")).toBe(false);
    await s.setWatchChangeAlerted("nope", []);
    expect(await s.listWatchChanges("nope", 5)).toEqual([]);
  });
});
