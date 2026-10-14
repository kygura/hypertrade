import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { FlowMetric, FlowRow, SnapshotRow } from "../../shared/intel.js";
import { releaseConnection, sql } from "../db.js";
import { MemoryIntelStore, PgIntelStore, type IntelStore, type NewAlert, type NewEvent } from "./store.js";

// PgIntelStore against a real Postgres, call for call against MemoryIntelStore.
// Runs only with INTEL_PG_TEST_URL set (CI without a database skips it):
//   INTEL_PG_TEST_URL=postgres://postgres@127.0.0.1:5433/hypertrade bun test src/server/intel/store.pg.test.ts
// Each run builds a throwaway schema, applies 007_intel.sql into it and drops it after.

const PG_URL = process.env.INTEL_PG_TEST_URL;
const SCHEMA = `intel_test_${process.pid}_${Date.now()}`;
const MIGRATIONS = ["007_intel.sql", "008_intel_stops.sql", "009_flow.sql"].map((f) => new URL(`../../../db/migrations/${f}`, import.meta.url));

const snap = (asset: string, ts: string, price: number, over: Partial<SnapshotRow> = {}): SnapshotRow => ({
  asset, ts, price, vol24h: null, funding: null, oiUsd: null, premium: null, basis: null,
  depthBid1: null, depthAsk1: null, depthBid2: null, depthAsk2: null, spreadBps: null, ...over,
});

const alert = (over: Partial<NewAlert> = {}): NewAlert => ({
  kind: "mapper", ref: "cluster-1", window: null, asset: "SOL", title: "Jito exploit", eventType: "exploit",
  line: { tag: "hypothesis", text: "Long SOL. LST collateral at risk." },
  path: [{ from: "Jito", to: "SOL", type: "collateral" }], edgeType: "collateral", hops: 1, pathWeight: 0.8,
  sources: [{ label: "rekt.news", url: "https://rekt.news/jito" }], materiality: 0.4, pricedIn: null, route: "push", ...over,
});

const event = (key: string, over: Partial<NewEvent> = {}): NewEvent => ({
  key, type: "exploit", title: `t ${key}`, summary: null, entities: [], assets: [], magnitude: "high",
  sources: [], origin: "rss", firstSeen: "2026-10-13T00:00:00.000Z", scheduledAt: null, catalyst: null, tag: "observed", ...over,
});

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const STAMPS = new Set(["createdAt", "updatedAt"]);

/**
 * Makes two stores' outputs comparable: ids become #1, #2… in order of first
 * appearance, server-clock stamps (createdAt/updatedAt, review ts) are checked
 * to be ISO strings and then dropped.
 */
function normalizer() {
  const ids = new Map<string, string>();
  const isId = (k: string, v: unknown) => typeof v === "string" && (k === "id" || /Id$/.test(k) || k === "ref") && /^[0-9a-f-]{36}$/.test(v);
  const walk = (v: unknown, key = "", parent?: object): unknown => {
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) {
        if (STAMPS.has(k) || (k === "ts" && "via" in v)) {
          expect(x).toMatch(ISO);
          continue;
        }
        out[k] = walk(x, k, v);
      }
      return out;
    }
    if (isId(key, v)) {
      const s = v as string;
      if (!ids.has(s)) ids.set(s, `#${ids.size + 1}`);
      return ids.get(s);
    }
    void parent;
    return v;
  };
  return (v: unknown) => walk(v);
}

/** Every IntelStore method, in an order whose results do not depend on the store's clock. */
async function scenario(s: IntelStore): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const n = normalizer();
  const put = (k: string, v: unknown) => (out[k] = n(v));

  // positions
  const p = await s.createManualPosition({ asset: "SOL", side: "long", size: 10, entryPx: 150.5, stopPx: 140, leverage: 3, venue: "binance" });
  const q = await s.createManualPosition({ asset: "BTC", side: "short", size: 0.1, entryPx: 60000, leverage: 1, venue: "hl" });
  put("pos.create", [p, q]);
  put("pos.get", await s.getManualPosition(p.id));
  put("pos.getMissing", await s.getManualPosition(crypto.randomUUID()));
  put("pos.update", await s.updateManualPosition(p.id, { asset: "SOL", side: "long", size: 12, entryPx: 151, leverage: 2, venue: "binance" }));
  put("pos.updateMissing", await s.updateManualPosition(crypto.randomUUID(), { asset: "X", side: "long", size: 1, entryPx: 1, leverage: 1, venue: "v" }));
  put("pos.list", await s.listManualPositions());
  put("pos.delete", [await s.deleteManualPosition(q.id), await s.deleteManualPosition(q.id)]);
  put("pos.listAfter", await s.listManualPositions());

  // watchlist: full replace keeps order; empty clears
  await s.putWatchlist([{ asset: "SOL", tags: ["l1"] }, { asset: "BTC", tags: [] }, { asset: "ETH", tags: ["l1", "core"] }]);
  put("wl.get", await s.getWatchlist());
  await s.putWatchlist([{ asset: "HYPE", tags: ["perp-dex"] }, { asset: "BTC", tags: ["core"] }]);
  put("wl.replaced", await s.getWatchlist());
  await s.putWatchlist([]);
  put("wl.empty", await s.getWatchlist());

  // reviews
  put("rev.none", await s.lastReview());
  const r1 = await s.logReview({ via: "ui" });
  const r2 = await s.logReview({ via: "deeplink", briefId: crypto.randomUUID() });
  put("rev.logged", [r1, r2]);
  put("rev.last", await s.lastReview());
  put("rev.list", await s.listReviews(1));
  put("rev.digest", await s.logReview({ via: "telegram_digest" })); // 009 widened the via CHECK

  // snapshots
  const full = snap("BTC", "2026-10-13T00:00:00.000Z", 1, {
    vol24h: 1e9, funding: -0.0000125, oiUsd: 2.5e9, premium: 0.0001, basis: -0.0002,
    depthBid1: 1e6, depthAsk1: 1.1e6, depthBid2: 2e6, depthAsk2: 2.2e6, spreadBps: 0.5,
  });
  put("snap.insert", await s.insertSnapshots([
    full,
    snap("BTC", "2026-10-13T00:15:00.000Z", 2),
    snap("BTC", "2026-10-13T00:30:00.000Z", 3),
    snap("ETH", "2026-10-13T00:20:00.000Z", 9),
    snap("BTC", "2026-10-13T00:15:00Z", 2.5), // same instant as above, different spelling: last wins
  ]));
  put("snap.upsert", await s.insertSnapshots([snap("BTC", "2026-10-13T02:30:00+02:00", 4)])); // = 00:30Z
  const at = (t: string) => new Date(`2026-10-13T${t}Z`);
  put("snap.nearest", [
    await s.nearestSnapshot("BTC", at("00:00:00")),
    await s.nearestSnapshot("BTC", at("00:20:00")),
    await s.nearestSnapshot("BTC", at("00:25:00")),
    await s.nearestSnapshot("BTC", at("00:22:30")), // tie → earlier
    await s.nearestSnapshot("BTC", at("00:16:00"), "after"),
    await s.nearestSnapshot("BTC", at("00:15:00"), "after"),
    await s.nearestSnapshot("BTC", at("00:29:00"), "before"),
    await s.nearestSnapshot("BTC", at("00:31:00"), "after"),
    await s.nearestSnapshot("BTC", at("05:00:00")),
    await s.nearestSnapshot("BTC", new Date("2026-10-12T00:00:00Z"), "before"),
    await s.nearestSnapshot("SOL", at("00:00:00")),
  ]);
  put("snap.range", await s.snapshotRange("BTC", at("00:00:00"), at("00:15:00")));
  put("snap.prune", await s.pruneSnapshots(at("00:10:00")));
  put("snap.rangeAfterPrune", (await s.snapshotRange("BTC", new Date(0), new Date("2030-01-01"))).map((r) => [r.ts, r.price]));

  // edges
  put("edge.user", await s.upsertEdges([{ src: "Jito", dst: "SOL", type: "collateral", weight: 0.9, source: null, lastVerified: null, origin: "user" }]));
  put("edge.llmOverUser", await s.upsertEdges([{ src: "Jito", dst: "SOL", type: "collateral", weight: 0.1, source: "https://x.io", lastVerified: "2026-10-13T00:00:00Z", origin: "llm" }]));
  put("edge.seed", await s.upsertEdges([
    { src: "USDC", dst: "HYPE", type: "settles_on", weight: 0.6, source: "seed", lastVerified: null, origin: "seed" },
    { src: "USDC", dst: "HYPE", type: "settles_on", weight: 0.65, source: "seed", lastVerified: null, origin: "seed" },
    { src: "ETH", dst: "SOL", type: "macro_beta", weight: 0.3, source: null, lastVerified: "2026-10-13T02:00:00+02:00", origin: "seed" },
  ]));
  put("edge.llmOverSeed", await s.upsertEdges([{ src: "ETH", dst: "SOL", type: "macro_beta", weight: 0.35, source: "https://y.io", lastVerified: null, origin: "llm" }]));
  put("edge.userOverUser", await s.upsertEdges([{ src: "Jito", dst: "SOL", type: "collateral", weight: 0.7, source: null, lastVerified: null, origin: "user" }]));
  put("edge.empty", await s.upsertEdges([]));
  put("edge.list", await s.listEdges());
  put("edge.for", await s.edgesFor(["HYPE"]));
  put("edge.forNone", await s.edgesFor([]));
  put("edge.delete", [
    await s.deleteUserEdge({ src: "USDC", dst: "HYPE", type: "settles_on" }),
    await s.deleteUserEdge({ src: "Jito", dst: "SOL", type: "collateral" }),
    await s.deleteUserEdge({ src: "Jito", dst: "SOL", type: "collateral" }),
  ]);

  put("edge.deleteLlm", [
    await s.deleteLlmEdges([{ src: "USDC", dst: "HYPE", type: "settles_on" }]), // seed: left alone
    await s.deleteLlmEdges([{ src: "ETH", dst: "SOL", type: "macro_beta" }, { src: "ETH", dst: "SOL", type: "macro_beta" }]),
    await s.listEdges(),
  ]);

  // events + clusters
  put("ev.empty", await s.upsertEvents([]));
  const [e1] = await s.upsertEvents([event("k1", { entities: ["Jito", "Solana"], assets: ["SOL"], sources: [{ label: "rss", url: "https://a.io/1" }] })]);
  const c = await s.upsertCluster({ label: "Jito", entities: ["Jito"], extraction: null, firstSeen: e1!.firstSeen, lastSeen: e1!.firstSeen, mappedAt: null });
  put("cl.insert", c);
  await s.setEventCluster([e1!.id], c.id);
  await s.setEventCluster([], c.id);
  put("ev.reingest", await s.upsertEvents([event("k1", { title: "a", firstSeen: "2026-10-14T00:00:00.000Z" }), event("k1", { title: "b" })]));
  put("ev.byCluster", await s.eventsByCluster(c.id));
  const c2 = await s.upsertCluster({ ...c, label: "Jito exploit", lastSeen: "2026-10-13T06:00:00+02:00", mappedAt: "2026-10-13T05:00:00Z",
    extraction: { type: "exploit", entities: ["Jito"], assets: ["SOL"], magnitude: "high", summary: "x", catalyst: null } as never });
  put("cl.update", c2);
  put("cl.get", [await s.getCluster(c.id), await s.getCluster(crypto.randomUUID())]);
  put("cl.list", [await s.listClusters(new Date("2026-10-13T03:00:00Z")), await s.listClusters(new Date("2026-10-13T05:00:00Z"))]);
  const [cat] = await s.upsertEvents([
    event("cat", { type: "unlock" as never, origin: "manual", scheduledAt: "2026-10-20T14:00:00+02:00", catalyst: { size: "2% supply", direction_hypothesis: "down" } as never, tag: "hypothesis" }),
  ]);
  await s.upsertEvents([event("cal", { origin: "calendar", scheduledAt: "2026-10-18T12:30:00Z", firstSeen: "2026-10-12T00:00:00Z" })]);
  put("ev.get", [await s.getEvent(cat!.id), await s.getEvent(crypto.randomUUID())]);
  put("ev.list", await s.listEvents({ limit: 10 }));
  put("ev.listSince", await s.listEvents({ since: new Date("2026-10-12T12:00:00Z"), limit: 10 }));
  put("ev.listType", await s.listEvents({ type: "unlock" as never, limit: 10 }));
  put("ev.listLimit", await s.listEvents({ limit: 1 }));
  put("ev.catalysts", await s.listCatalysts(new Date("2026-10-13"), new Date("2026-10-27")));
  put("ev.catalystEdge", await s.listCatalysts(new Date("2026-10-20T12:00:00Z"), new Date("2026-10-20T12:00:00Z")));
  put("ev.deleteManual", [await s.deleteManualEvent(e1!.id), await s.deleteManualEvent(cat!.id), await s.deleteManualEvent(cat!.id)]);

  // alerts + feedback
  const a1 = await s.insertAlert(alert({ asset: "A", trace: { promptVersion: "p1", tier: "cheap", model: null, inputs: { a: 1 }, output: null, usage: null, ms: 3, error: "llm not configured" } }));
  put("al.insert", a1);
  put("al.dup", await s.insertAlert(alert({ asset: "A", materiality: 0.9 })));
  const b = (await s.insertAlert(alert({ asset: "B", pricedIn: { pricePct: -4.1, oiPct: null, since: "2026-10-13T00:00:00.000Z" } })))!;
  const cc = (await s.insertAlert(alert({ asset: "C", eventType: "listing", edgeType: "narrative", hops: 2 })))!;
  const d = (await s.insertAlert(alert({ asset: "D", eventType: "listing", edgeType: "narrative", hops: 2, route: "batch" })))!;
  await s.insertAlert(alert({ kind: "catalyst", ref: "ev-1", window: "24h", eventType: null, edgeType: null, hops: 0, path: [] }));
  await s.insertAlert(alert({ kind: "catalyst", ref: "ev-1", window: "1h", eventType: null, edgeType: null, hops: 0, path: [] }));
  put("al.dupWindow", await s.insertAlert(alert({ kind: "catalyst", ref: "ev-1", window: "1h" })));
  put("al.exists", [
    await s.alertExists({ kind: "catalyst", ref: "ev-1", asset: "SOL", window: "1h" }),
    await s.alertExists({ kind: "catalyst", ref: "ev-1", asset: "SOL", window: null }),
    await s.alertExists({ kind: "mapper", ref: "cluster-1", asset: "A", window: null }),
  ]);
  await s.setAlertFeedback(a1!.id, 1);
  await s.setAlertFeedback(b.id, -1);
  await s.setAlertFeedback(cc.id, 1);
  put("al.revote", await s.setAlertFeedback(cc.id, -1));
  await s.setAlertFeedback(d.id, -1);
  put("al.clear", await s.setAlertFeedback(d.id, null));
  put("al.voteMissing", await s.setAlertFeedback(crypto.randomUUID(), 1));
  put("al.get", [await s.getAlert(b.id), await s.getAlert(crypto.randomUUID())]);
  put("al.list", await s.listAlerts({ limit: 50 }));
  put("al.listKind", await s.listAlerts({ kind: "catalyst", limit: 50 }));
  put("al.listRoute", await s.listAlerts({ route: "batch", limit: 50 }));
  put("al.listSinceFuture", await s.listAlerts({ since: new Date(Date.now() + 3_600_000), limit: 50 }));
  put("al.listLimit", await s.listAlerts({ limit: 2 }));
  put("fb.stats", await s.feedbackStats());
  put("fb.statsSince", await s.feedbackStats(new Date(Date.now() - 3_600_000)));
  put("fb.statsFuture", await s.feedbackStats(new Date(Date.now() + 3_600_000)));

  // briefs
  put("br.none", await s.latestBrief());
  const body = { since: "2026-10-13T00:00:00.000Z", items: [], alerts: [], catalysts: [], lines: [], silent: true };
  await s.insertBrief({ ...body, surface: "cron" });
  const ui = await s.insertBrief({
    ...body, since: "2026-10-13T02:00:00+02:00", surface: "ui", silent: false, threshold: { minZ: 2, pushMateriality: 0.35 }, diffedCount: 3,
    lines: [{ tag: "observed", text: "BTC −4%", source: { label: "snapshot", url: "/markets/BTC" }, ts: "2026-10-13T00:00:00.000Z" }],
    trace: { promptVersion: "brief/1", tier: "strong", model: null, inputs: null, output: null, usage: null, ms: 0, error: "llm not configured" },
  });
  put("br.insert", ui);
  put("br.latest", [await s.latestBrief(), await s.latestBrief("cron"), await s.latestBrief("ui")]);

  // trade notes
  put("tn.empty", await s.tradeNotes([]));
  await s.putTradeNote({ tradeId: "desk:ETH:1", note: "late", tag: null, summary: null });
  put("tn.replace", await s.putTradeNote({ tradeId: "desk:ETH:1", note: null, tag: "breakout", summary: { tag: "hypothesis", text: "chased" } }));
  put("tn.get", await s.tradeNotes(["desk:ETH:1", "hl:BTC:9"]));

  // reports
  put("rp.none", await s.latestReport("journal_weekly"));
  await s.insertReport({ kind: "feedback_weekly", buckets: [{ eventType: "exploit", edgeType: "collateral", hops: 1, up: 0, down: 5, total: 5, suggestion: "demote" }] });
  put("rp.insert", await s.insertReport({ kind: "journal_weekly", periodDays: 7, leaks: [], edges: [], lines: [] }));
  put("rp.latest", [await s.latestReport("feedback_weekly"), await s.latestReport("journal_weekly")]);

  // theses
  const th = await s.insertThesis({
    text: "SOL holds 140", assets: ["SOL"],
    claims: [{ kind: "claim", text: "SOL > 140", check: { kind: "price_vs_level", asset: "SOL", op: ">", level: 140 }, status: "unknown" }],
    invalidation: [{ text: "close < 130" }], wrongIf: [{ tag: "hypothesis", text: "funding flips" }], checkedAt: null,
  });
  put("th.insert", th);
  put("th.update", await s.updateThesis(th.id, { checkedAt: "2026-10-13T02:00:00+02:00", invalidation: [{ text: "close < 130", status: "clear" }] }));
  put("th.updateMissing", await s.updateThesis(crypto.randomUUID(), { checkedAt: null }));
  put("th.get", [await s.getThesis(th.id), await s.getThesis(crypto.randomUUID())]);
  put("th.list", await s.listTheses());
  put("th.delete", [await s.deleteThesis(th.id), await s.deleteThesis(th.id)]);

  // watches
  const w = await s.insertWatch({ kind: "evm_wallet", target: "0x" + "b".repeat(40), chain: "base", label: "treasury" });
  const u = await s.insertWatch({ kind: "url", target: "https://docs.example.com/a", asset: "SOL", label: "docs" } as never);
  put("wa.insert", [w, u]);
  await s.updateWatchState(w.id, { lastHash: "h1", lastSnapshot: { balance: "1", nonce: 2 }, checkedAt: "2026-10-13T00:00:00Z", error: null });
  await s.updateWatchState(u.id, { lastHash: null, lastSnapshot: null, checkedAt: "2026-10-13T00:00:00Z", error: "fetch failed" });
  put("wa.list", await s.listWatches());
  put("wa.get", [await s.getWatch(w.id), await s.getWatch(crypto.randomUUID())]);
  const ch = await s.insertWatchChange({ watchId: w.id, fromHash: null, toHash: "h1", diff: null, facts: ["nonce 1 → 2"], detail: { nonce: [1, 2] }, lines: [], ts: "2026-10-13T02:00:00+02:00" });
  await s.insertWatchChange({ watchId: w.id, fromHash: "h1", toHash: "h2", diff: "+a", facts: [], detail: null, lines: [{ tag: "hypothesis", text: "x" }], ts: "2026-10-13T01:00:00Z" });
  put("wc.insert", ch);
  await s.setWatchChangeAlerted(ch.id, ["ETH"]);
  put("wc.list", await s.listWatchChanges(w.id, 10));
  put("wc.listLimit", await s.listWatchChanges(w.id, 1));
  let threw = false;
  await s.insertWatchChange({ watchId: crypto.randomUUID(), fromHash: null, toHash: "h", diff: null, facts: [], detail: null, lines: [] }).catch(() => (threw = true));
  put("wc.orphanThrows", threw);
  put("wa.delete", [await s.deleteWatch(w.id), await s.deleteWatch(w.id)]);
  put("wc.cascade", await s.listWatchChanges(w.id, 10));

  // settings
  put("set.none", await s.getSetting("x"));
  await s.setSetting("x", { n: 1, list: [1, "a"] });
  await s.setSetting("y", ["a", "b"]);
  await s.setSetting("z", 42);
  await s.setSetting("x", { n: 2 });
  put("set.get", [await s.getSetting("x"), await s.getSetting("y"), await s.getSetting("z")]);

  // LLM cache
  put("cache.none", await s.cacheGet("k", "v1"));
  await s.cachePut("k", "v1", { a: 1 }, { in: 10 });
  await s.cachePut("k", "v2", ["x"], null);
  await s.cachePut("k", "v1", { a: 3 }, null);
  put("cache.get", [await s.cacheGet("k", "v1"), await s.cacheGet("k", "v2"), await s.cacheGet("k", "v3")]);
  put("cache.calls", [await s.callsSince(new Date(Date.now() - 60_000)), await s.callsSince(new Date(Date.now() + 60_000))]);

  // stops (journal R for HL trades)
  put("stop.record", await s.recordStops([
    { asset: "SOL", side: "long", ts: "2026-10-13T01:00:00Z", stopPx: 140 },
    { asset: "SOL", side: "long", ts: "2026-10-13T03:00:00+02:00", stopPx: 138 },
    { asset: "SOL", side: "short", ts: "2026-10-13T02:00:00Z", stopPx: 170 },
  ]));
  put("stop.at", [
    await s.stopAt("SOL", "long", new Date("2026-10-13T00:30:00Z")),
    await s.stopAt("SOL", "long", new Date("2026-10-13T00:30:00Z"), new Date("2026-10-13T01:00:00Z")),
    await s.stopAt("SOL", "short", new Date("2026-10-13T00:00:00Z")),
    await s.stopAt("ETH", "long", new Date("2026-10-13T00:00:00Z")),
  ]);
  put("stop.prune", await s.pruneStops(new Date("2026-10-13T01:30:00Z")));
  put("stop.afterPrune", await s.stopAt("SOL", "long", new Date("2026-10-12T00:00:00Z")));

  // flow
  const flow = (metric: FlowMetric, ts: string, value: number, venue = "agg", asset = "BTC"): FlowRow => ({ asset, venue, metric, value, ts });
  put("flow.insert", await s.insertFlow([
    flow("oi_usd", "2026-10-13T00:15:00.000Z", 2.5e9),
    flow("oi_usd", "2026-10-13T00:00:00.000Z", 2.4e9),
    flow("funding", "2026-10-13T00:00:00.000Z", -1.25e-5),
    flow("spot_volume_usd", "2026-10-13T00:00:00.000Z", 1.5e6, "binance"),
    flow("long_short_ratio", "2026-10-13T00:00:00.000Z", 1.2, "agg", "ETH"),
    flow("oi_usd", "2026-10-13T00:15:00Z", 2.6e9), // same instant: last wins
  ]));
  put("flow.upsert", await s.insertFlow([flow("oi_usd", "2026-10-13T02:00:00+02:00", 2.45e9)])); // = 00:00Z
  put("flow.empty", await s.insertFlow([]));
  put("flow.series", [
    await s.flowSeries("BTC", null, new Date("2026-10-12T00:00:00Z")),
    await s.flowSeries("BTC", "oi_usd", new Date("2026-10-13T00:15:00Z")),
    await s.flowSeries("SOL", null, new Date(0)),
  ]);
  put("flow.latest", [
    await s.latestFlowTs("BTC", "agg", "oi_usd"),
    await s.latestFlowTs("BTC", "binance", "spot_volume_usd"),
    await s.latestFlowTs("BTC", "binance", "oi_usd"),
  ]);
  put("flow.prune", await s.pruneFlow(new Date("2026-10-13T00:10:00Z")));
  put("flow.afterPrune", await s.flowSeries("BTC", null, new Date(0)));

  return out;
}

describe.skipIf(!PG_URL)("PgIntelStore (real Postgres) matches MemoryIntelStore", () => {
  const saved = process.env.DATABASE_URL;
  const pg = new PgIntelStore();
  const usePath = () => sql().unsafe(`set search_path to "${SCHEMA}"`);

  beforeAll(async () => {
    process.env.DATABASE_URL = PG_URL;
    await releaseConnection();
    await sql().unsafe(`create schema "${SCHEMA}"`);
    await usePath();
    for (const m of MIGRATIONS) await sql().unsafe(readFileSync(m, "utf8"));
  });

  // The client is one connection; re-pin the schema in case it was recycled.
  beforeEach(async () => {
    await usePath();
  });

  afterAll(async () => {
    try {
      await sql().unsafe(`set client_min_messages to warning`);
      await sql().unsafe(`drop schema if exists "${SCHEMA}" cascade`);
    } finally {
      await releaseConnection();
      if (saved === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = saved;
    }
  });

  test("the migration landed in the throwaway schema", async () => {
    const [row] = await sql()`select count(*)::int as n from information_schema.tables where table_schema = ${SCHEMA} and table_name like 'intel_%'`;
    expect(row!.n).toBe(18);
  });

  test("every method returns what the memory store returns", async () => {
    const mem = await scenario(new MemoryIntelStore());
    const real = await scenario(pg);
    for (const k of Object.keys(mem)) expect({ [k]: real[k] }).toEqual({ [k]: mem[k] });
    expect(Object.keys(real)).toEqual(Object.keys(mem));
  });

  test("timestamps come back as ISO strings, numbers as numbers, jsonb lists as arrays", async () => {
    const s = pg;
    const [e] = await s.upsertEvents([event("types", { entities: ["A"], assets: ["SOL"], scheduledAt: "2026-11-01T00:00:00Z" })]);
    expect(e!.firstSeen).toMatch(ISO);
    expect(e!.scheduledAt).toBe("2026-11-01T00:00:00.000Z");
    expect(Array.isArray(e!.entities) && Array.isArray(e!.assets) && Array.isArray(e!.sources)).toBe(true);
    await s.insertSnapshots([snap("TYP", "2026-10-13T00:00:00Z", 1.5, { funding: 1e-5, oiUsd: 123.25 })]);
    const r = (await s.nearestSnapshot("TYP", new Date("2026-10-13T00:00:00Z")))!;
    expect(r).toMatchObject({ ts: "2026-10-13T00:00:00.000Z", price: 1.5, funding: 1e-5, oiUsd: 123.25 });
    expect(typeof r.price).toBe("number");
    const a = (await s.insertAlert(alert({ ref: "types" })))!;
    await s.setAlertFeedback(a.id, -1);
    expect((await s.getAlert(a.id))!.feedback).toBe(-1);
    const fb = await s.feedbackStats();
    for (const bkt of fb) for (const k of ["hops", "up", "down", "total"] as const) expect(typeof bkt[k]).toBe("number");
  });

  test("ids that are not uuids read as missing, like the memory store (no SQL error)", async () => {
    const s = pg;
    for (const bad of ["nope", "------------------------------------"]) {
      expect(await s.getManualPosition(bad)).toBeNull();
      expect(await s.deleteManualPosition(bad)).toBe(false);
      expect(await s.getAlert(bad)).toBeNull();
      expect(await s.setAlertFeedback(bad, 1)).toBeNull();
      expect(await s.getEvent(bad)).toBeNull();
      expect(await s.deleteManualEvent(bad)).toBe(false);
      expect(await s.getCluster(bad)).toBeNull();
      expect(await s.eventsByCluster(bad)).toEqual([]);
      expect(await s.getThesis(bad)).toBeNull();
      expect(await s.deleteThesis(bad)).toBe(false);
      expect(await s.getWatch(bad)).toBeNull();
      expect(await s.deleteWatch(bad)).toBe(false);
      expect(await s.listWatchChanges(bad, 5)).toEqual([]);
    }
  });
});
