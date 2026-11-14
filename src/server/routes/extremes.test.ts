import { describe, expect, test } from "bun:test";
import { EXTREMES_SCORE_VERSION, type ExtremeEvent, type ExtremeGrade, type ExtremeRecord } from "../../shared/extremes.js";
import type { Alert } from "../desk/notify.js";
import type { ExtremeSummaryRow } from "../extremes/grade.js";
import { createAlerts } from "../platform/alerts.js";
import { Bus } from "../platform/bus.js";
import type { PlatformContext } from "../platform/context.js";
import { MemoryPlatformStore } from "../platform/store-memory.js";
import { cronExtremesRoutes, extremesRoutes, freshMid, runExtremesCron, type CronExtremesDeps, type ExtremesRouteDeps } from "./extremes.js";

const NOW = new Date("2026-11-14T12:30:00.000Z");
const ev = (coin: string, over: Partial<ExtremeEvent> = {}): ExtremeEvent => ({
  key: `oi_flush|${coin}|long`, kind: "oi_flush", coin, side: "long", ts: "2026-11-14T12:00:00.000Z", window: "4h", mark: 100, severity: 4,
  facts: { oiChg: -0.2 }, line: `${coin} OI -20% in 4h`, ...over,
});

const HOUR = 3_600_000;
const iso = (t: number) => new Date(t).toISOString();

/** 5-min snapshots from 25 h before NOW to `to` for SOL (the thinnest of three by volume: tier 3) plus ETH and BTC; SOL marks from `markAt`. */
async function snapshots(store: MemoryPlatformStore, markAt: (t: number) => number = () => 100, to = NOW.getTime()) {
  const rows = [];
  for (let t = NOW.getTime() - 25 * HOUR; t <= to; t += 5 * 60_000) {
    rows.push({ coin: "SOL", ts: iso(t), inputs: { mark: markAt(t), oiUsd: 5e8, funding: 1e-5, dayNtlVlm: 2e9 } });
    rows.push({ coin: "ETH", ts: iso(t), inputs: { mark: 3000, oiUsd: 1e9, funding: 1e-5, dayNtlVlm: 5e9 } });
    rows.push({ coin: "BTC", ts: iso(t), inputs: { mark: 90000, oiUsd: 2e9, funding: 1e-5, dayNtlVlm: 9e9 } });
  }
  await store.insertScanSnapshots(rows);
}

async function setup(mark: number | null = 100, opts: { store?: MemoryPlatformStore; publish?: ExtremesRouteDeps["publish"]; now?: Date } = {}) {
  const store = opts.store ?? new MemoryPlatformStore();
  await store.insertExtremeEvent({ event: ev("SOL"), delivery: "woken", verdict: null, verdictAt: null, verdictMark: null, opportunityId: null });
  await store.insertExtremeEvent({ event: ev("ETH", { ts: "2026-11-01T00:00:00.000Z" }), delivery: "pushed", verdict: null, verdictAt: null, verdictMark: null, opportunityId: null });
  const sent: Alert[] = [];
  const marks: string[] = [];
  const app = extremesRoutes({
    store: () => store,
    mark: async (coin) => (marks.push(coin), mark),
    notifier: () => ({ send: async (a) => (sent.push(a), ["ntfy"]) }),
    appUrl: () => "https://app.example",
    now: () => opts.now ?? NOW,
    publish: opts.publish,
    env: {},
  });
  const post = (b: unknown) => app.request("/verdict", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
  return { store, sent, marks, app, post };
}

const take = { key: "oi_flush|SOL|long", stance: "take", direction: "long", killPx: 92, cause: "Liquidation cascade after an exchange outage; no lasting news." };
const TAKE_BODY = "SOL OI -20% in 4h\nLiquidation cascade after an exchange outage; no lasting news.\nKill 92 (mark 100)";

describe("POST /extremes/verdict", () => {
  test("schema rejects: missing direction or kill on take, unknown stance, extra fields", async () => {
    const { post, store, sent } = await setup();
    for (const b of [{ ...take, killPx: undefined }, { ...take, direction: undefined }, { ...take, stance: "buy" }, { ...take, size: 1 }, { ...take, cause: "" }, "nope"]) {
      expect((await post(b)).status).toBe(400);
    }
    expect((await store.latestExtreme("oi_flush|SOL|long"))!.verdict).toBeNull();
    expect(sent).toEqual([]);
  });

  test("unknown key 404, already answered 409", async () => {
    const { post } = await setup();
    expect((await post({ ...take, key: "oi_flush|NOPE|long" })).status).toBe(404);
    expect((await post(take)).status).toBe(200);
    expect((await post({ ...take, stance: "pass" })).status).toBe(409);
  });

  test("take with the kill on the wrong side of the mark: 422, nothing stored or pushed", async () => {
    const { post, store, sent } = await setup(100);
    const long = await post({ ...take, killPx: 101 });
    expect(long.status).toBe(422);
    expect(await long.json()).toMatchObject({ field: "killPx", mark: 100 });
    expect((await post({ ...take, direction: "short", killPx: 99 })).status).toBe(422);
    expect((await post({ ...take, killPx: 100 })).status).toBe(422);
    expect((await store.latestExtreme("oi_flush|SOL|long"))!.verdict).toBeNull();
    expect(store.opportunities.size).toBe(0);
    expect(sent).toEqual([]);
  });

  test("take without a fresh mark: 503, nothing stored", async () => {
    const { post, store } = await setup(null);
    expect((await post(take)).status).toBe(503);
    expect((await store.latestExtreme("oi_flush|SOL|long"))!.verdict).toBeNull();
    expect(store.opportunities.size).toBe(0);
  });

  test("take: stamps the mark, stores the verdict, opens a ready opportunity and pushes exactly once", async () => {
    const { post, store, sent, marks } = await setup(100);
    await snapshots(store);
    const res = await post(take);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mark: number; pushed: string[]; record: ExtremeRecord; opportunity: { id: string; status: string; created: boolean }; opportunityReason: string | null };
    expect(body).toMatchObject({ mark: 100, pushed: ["ntfy"], record: { verdictAt: NOW.toISOString(), verdictMark: 100 }, opportunity: { status: "ready", created: true }, opportunityReason: null });
    expect(body.record.opportunityId).toBe(body.opportunity.id);
    expect(marks).toEqual(["SOL"]);
    const stored = (await store.latestExtreme("oi_flush|SOL|long"))!;
    expect(stored).toMatchObject({ verdict: { ...take, sources: [] }, verdictMark: 100, opportunityId: body.opportunity.id });
    expect(sent).toEqual([{
      level: "warn", title: "Take: long SOL", click: "https://app.example/coin/SOL",
      body: `${TAKE_BODY}\nApprove or reject on the coin page; expires in 4 h.`,
    }]);

    // The opportunity: only what is known, under its own score version.
    const o = (await store.getOpportunity(body.opportunity.id))!;
    expect(o).toMatchObject({
      coin: "SOL", direction: "long", setupKind: "oi_flush", tradeType: "directional", status: "ready", score: 4, scoreVersion: EXTREMES_SCORE_VERSION,
      entryPx: 100, stopPx: 92, invalidationPx: 92, targetPx: null, costs: null, netEdgeBps: null, grossEdgeBps: null, edgeBasis: "unvalidated",
      tags: ["extreme", "oi_flush"], liquidityTier: 3, dedupeKey: "SOL|long|oi_flush",
    });
    expect(o.invalidation).toBe("Below 92 (kill). Liquidation cascade after an exchange outage; no lasting news.");
    expect(o.regime).toBe("range"); // flat marks: features.ts labels it as the scanner does
    const ledger = await store.ledgerFor(o.id);
    expect(ledger.map((e) => (e.kind === "status" ? `${e.payload.from}->${e.payload.to}:${e.payload.actor}` : e.kind))).toEqual(["created", "new->calculated:system", "calculated->ready:system"]);
    expect(ledger[0]!.payload).toEqual({
      features: { features: { oiChg: -0.2 }, inputs: { mark: 100, verdictMark: 100, killPx: 92, eventTs: "2026-11-14T12:00:00.000Z", window: "4h", source: "extremes" } },
      market: { mark: 100, dayNtlVlm: 2e9, oiUsd: 5e8 }, score: 4, scoreVersion: EXTREMES_SCORE_VERSION,
    });

    expect((await post(take)).status).toBe(409);
    expect(sent.length).toBe(1);
    expect(store.opportunities.size).toBe(1);
  });

  test("take with a live row on the same coin|direction|kind: the verdict is kept and reports that row; no second row", async () => {
    const store = new MemoryPlatformStore();
    const { opportunity: live } = await store.upsertOpportunity(
      { coin: "SOL", direction: "long", setupKind: "oi_flush", tradeType: "directional", score: 6, scoreVersion: EXTREMES_SCORE_VERSION, tags: ["extreme", "oi_flush"], liquidityTier: 1, regime: "unknown", invalidation: "Below 90 (kill). x", entryPx: 99, stopPx: 90, targetPx: null, invalidationPx: 90 },
      { features: { features: {}, inputs: {} }, market: {}, score: 6, scoreVersion: EXTREMES_SCORE_VERSION },
    );
    const { post, sent } = await setup(100, { store });
    const body = (await (await post(take)).json()) as { record: ExtremeRecord; opportunity: { id: string; created: boolean; status: string }; opportunityReason: string | null };
    expect(body.opportunity).toEqual({ id: live.id, created: false, status: "new" });
    expect(body.opportunityReason).toBe("opportunity is new, not ready");
    expect(body.record).toMatchObject({ verdict: { stance: "take" }, opportunityId: live.id });
    expect(store.opportunities.size).toBe(1);
    expect((await store.getOpportunity(live.id))).toMatchObject({ stopPx: 90, score: 6 }); // never refreshed by the verdict
    expect(sent.map((a) => a.body)).toEqual([TAKE_BODY]); // not ready: no approve line
  });

  test("opportunity creation fails: the verdict is stored, the push goes out, opportunity null with the reason", async () => {
    const store = new MemoryPlatformStore();
    store.upsertOpportunity = async () => {
      throw new Error("db down");
    };
    const { post, sent } = await setup(100, { store });
    const res = await post(take);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ opportunity: null, opportunityReason: "opportunity not created: db down", record: { verdictMark: 100, opportunityId: null } });
    expect((await store.latestExtreme("oi_flush|SOL|long"))!.verdict?.stance).toBe("take");
    expect(sent.map((a) => a.title)).toEqual(["Take: long SOL"]);
  });

  test("one push per take in both runtimes: the always-on bus (alerts.ts subscribed) adds no Ready push; serverless has no bus", async () => {
    for (const runtime of ["always-on", "serverless"] as const) {
      const bus = new Bus();
      const fromAlerts: Alert[] = [];
      const alerts = createAlerts({ notifier: { send: async (a) => (fromAlerts.push(a as Alert), ["ntfy"]) }, wsAgeSec: () => 1, pushScore: 3 });
      alerts.subscribe(bus);
      const events: string[] = [];
      bus.subscribe("opportunity", ({ opportunity: o, change }) => void events.push(`${change}:${o.status}`));
      const { post, sent } = await setup(100, { publish: runtime === "always-on" ? (opportunity, change) => bus.publish("opportunity", { opportunity, change }) : undefined });
      expect((await post(take)).status).toBe(200);
      await new Promise((r) => setTimeout(r, 0));
      expect({ runtime, events }).toEqual({ runtime, events: runtime === "always-on" ? ["created:new", "status:calculated", "status:ready"] : [] });
      expect({ runtime, pushes: [...sent, ...fromAlerts].map((a) => a.title) }).toEqual({ runtime, pushes: ["Take: long SOL"] });
    }
  });

  test("watch and pass: stored with the stamped mark (null without one), no opportunity, no push", async () => {
    for (const [stance, mark] of [["watch", 101], ["pass", null]] as const) {
      const { post, store, sent, marks } = await setup(mark);
      const res = await post({ key: "oi_flush|SOL|long", stance, cause: "Token unlock priced in." });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ mark, pushed: [], opportunity: null, record: { verdictMark: mark, opportunityId: null } });
      expect((await store.latestExtreme("oi_flush|SOL|long"))!.verdict?.stance).toBe(stance);
      expect(sent).toEqual([]);
      expect(marks).toEqual(["SOL"]);
      expect(store.opportunities.size).toBe(0);
    }
  });

  test("a mark read that throws is no mark: a watch is still stored", async () => {
    const store = new MemoryPlatformStore();
    await store.insertExtremeEvent({ event: ev("SOL"), delivery: "woken", verdict: null, verdictAt: null, verdictMark: null, opportunityId: null });
    const app = extremesRoutes({ store: () => store, mark: async () => { throw new Error("allMids down"); }, notifier: () => ({ send: async () => [] }), appUrl: () => null, now: () => NOW });
    const res = await app.request("/verdict", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: "oi_flush|SOL|long", stance: "watch", cause: "x" }) });
    expect(res.status).toBe(200);
    expect((await store.latestExtreme("oi_flush|SOL|long"))!.verdictMark).toBeNull();
  });
});

describe("GET /extremes", () => {
  test("lists records in the last `days`, newest first; rejects a bad days", async () => {
    const { app } = await setup();
    const week = (await (await app.request("/?days=7")).json()) as { records: { event: { coin: string } }[] };
    expect(week.records.map((r) => r.event.coin)).toEqual(["SOL"]);
    const month = (await (await app.request("/?days=30")).json()) as { records: { event: { coin: string } }[] };
    expect(month.records.map((r) => r.event.coin)).toEqual(["SOL", "ETH"]);
    expect((await app.request("/?days=0")).status).toBe(400);
    expect((await app.request("/?days=7&x=1")).status).toBe(400);
  });

  test("each record carries its grade from stored snapshots, plus a summary by stance and kind; one snapshot read per coin", async () => {
    const later = new Date(NOW.getTime() + 30 * HOUR);
    const store = new MemoryPlatformStore();
    // SOL rises 1% an hour after the verdict at 12:30 (mark 100), from 100.
    await snapshots(store, (t) => (t <= NOW.getTime() ? 100 : 100 * (1 + (0.01 * (t - NOW.getTime())) / HOUR)), later.getTime());
    const { post, app } = await setup(100, { store });
    expect((await post(take)).status).toBe(200);
    const reads: Array<readonly string[] | undefined> = [];
    const orig = store.scanSnapshotsSince.bind(store);
    store.scanSnapshotsSince = async (since, coins) => (reads.push(coins), orig(since, coins));
    const graded = extremesRoutes({ store: () => store, mark: async () => 100, notifier: () => ({ send: async () => [] }), appUrl: () => null, now: () => later });
    const body = (await (await graded.request("/?days=30")).json()) as { records: Array<ExtremeRecord & { grade: ExtremeGrade }>; summary: ExtremeSummaryRow[] };
    expect(reads).toEqual([["SOL"], ["ETH"]]);
    const sol = body.records.find((r) => r.event.coin === "SOL")!;
    expect(sol.grade).toMatchObject({ direction: "long", entryPx: 100, entryBasis: "verdict", killHit: false });
    expect(sol.grade.horizons.map((h) => h.horizon)).toEqual(["4h", "24h", "72h"]);
    expect(sol.grade.horizons[0]!.raw).toBeCloseTo(0.04, 3);
    expect(sol.grade.horizons[1]!.raw).toBeCloseTo(0.24, 3);
    expect(sol.grade.horizons[2]!.raw).toBeNull(); // not reached
    const takes = body.summary.find((r) => r.by === "stance" && r.group === "take")!;
    expect(takes).toMatchObject({ n: 1, graded: 1, killHitRate: 0 });
    expect(takes.horizons[1]!.raw.n).toBe(1);
    expect(body.summary.find((r) => r.by === "kind" && r.group === "oi_flush")).toMatchObject({ n: 2, graded: 1 });
    expect(body.summary.find((r) => r.by === "stance" && r.group === "none")).toMatchObject({ n: 1, graded: 0, killHitRate: null });
    void app;
  });
});

describe("POST /cron/extremes", () => {
  const lease = (free = true) => ({ acquire: async () => free, release: async () => {} });
  const job = (): ReturnType<CronExtremesDeps["job"]> => ({
    store: new MemoryPlatformStore(), detect: () => [], lookbackMs: 1, wake: async () => false, notifier: { send: async () => [] }, appUrl: null, now: () => NOW.getTime(),
  });

  test("503 without a database, skipped when leased, counts otherwise", async () => {
    expect((await runExtremesCron({ hasDb: () => false, lease: lease(), job })).status).toBe(503);
    expect(await runExtremesCron({ hasDb: () => true, lease: lease(false), job })).toEqual({ status: 200, body: { ok: true, skipped: "leased" } });
    const r = await runExtremesCron({ hasDb: () => true, lease: lease(), job });
    expect(r).toEqual({ status: 200, body: { ok: true, coins: 0, evaluated: 0, fired: 0, new: 0, woken: 0, pushed: 0, capped: 0, undelivered: 0, expired: 0, lines: [] } });
  });

  test("a failing job is a 500 body; the route needs the cron token", async () => {
    const bad = () => ({ ...job(), store: { ...new MemoryPlatformStore(), scanSnapshotsSince: async () => { throw new Error("db down"); } } as never });
    expect(await runExtremesCron({ hasDb: () => true, lease: lease(), job: bad })).toEqual({ status: 500, body: { ok: false, error: "db down" } });
    process.env.CRON_TOKEN ??= "extremes-test-token";
    const app = cronExtremesRoutes(() => ({ hasDb: () => false, lease: lease(), job }));
    expect((await app.request("/extremes", { method: "POST" })).status).toBe(401);
    expect((await app.request("/extremes", { method: "POST", headers: { "x-cron-token": process.env.CRON_TOKEN! } })).status).toBe(503);
  });
});

describe("freshMid", () => {
  const ctx = (age: number | null, mid: number | null): PlatformContext => ({
    store: new MemoryPlatformStore(), midAge: () => age, mid: () => mid, lastScanAt: async () => null, nearMisses: async () => [], scanIntervalSec: 60, refreshMids: async () => {},
  });
  test("the mid only while it is fresh (the approval gate's age limit)", async () => {
    expect(await freshMid(ctx(2, 101), "SOL", 0)).toBe(101);
    expect(await freshMid(ctx(31, 101), "SOL", 0)).toBeNull();
    expect(await freshMid(ctx(null, 101), "SOL", 0)).toBeNull();
    expect(await freshMid(ctx(2, null), "SOL", 0)).toBeNull();
  });
});
