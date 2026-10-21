import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import {
  FeedResponseSchema, LedgerEntriesResponseSchema, LedgerStatsResponseSchema, LiqBoardResponseSchema, LiqMapHistoryResponseSchema, LiqMapResponseSchema, NearMissResponseSchema, NoveltyResponseSchema, type NearMiss, OpportunityDetailSchema,
  type LedgerPayload, type Opportunity,
} from "../../shared/platform.js";
import { app as apiApp } from "../../../api/index.js";
import { requireAuth, signSession } from "../auth.js";
import { makeService } from "../desk/testkit.js";
import { dbPlatformContext, type PlatformContext } from "../platform/context.js";
import { reconcileOnce } from "../platform/reconcile.js";
import { setHealthExtras } from "../platform/runtime.js";
import { MemoryPlatformStore } from "../platform/store-memory.js";
import { createPlatformRoutes, defaultPlatformDeps, deskRisk, type PlatformDeps, type RiskGate } from "./platform.js";

const NOW = new Date("2026-10-16T12:00:00Z");
const ADDR = `0x${"a".repeat(40)}`;
const created: LedgerPayload<"created"> = {
  features: { features: { ret15mZ: 2.1, priceAccelZ: 1.2, fundingPctile14d: 0.9 }, inputs: { mark: 4000, ret15mPct: 0.012 } },
  market: { mark: 4000 }, score: 2.5, scoreVersion: "v1",
};
const costs = { feeBps: 4.5, slippageBps: 2, fundingBps: 1, absorbableUsd: 50_000, grossEdgeBps: 120, netEdgeBps: 108, edgeBasis: "unvalidated" as const };
const approvedVerdict = { approved: true, reasons: [], warnings: [], equityUsd: 10_000, sizing: { notionalUsd: 1000 } };
const gate = (over: Partial<RiskGate> = {}): RiskGate & { placed: number } => {
  const g: RiskGate & { placed: number } = {
    placed: 0,
    assess: async () => ({ before: { approved: true, reasons: [], warnings: [] }, after: approvedVerdict }),
    place: async () => (g.placed++, { status: "executed", reasons: [], proposalId: "p1" }),
    ...over,
  };
  return g;
};

let store: MemoryPlatformStore;
let ctx: PlatformContext;
let midAge: number | null;
let lastScan: Date | null;
let nearMisses: NearMiss[];
let risk: ReturnType<typeof gate>;
let online: boolean;
const research = { run: async () => null as never, get: async () => null };
let deps: PlatformDeps;

let app: Hono;
const req = (path: string, init?: RequestInit) => app.request(`/api/platform${path}`, init);
const post = (path: string, body?: unknown) => req(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });

async function seed(status: "new" | "ready" = "ready", over: Partial<Parameters<MemoryPlatformStore["upsertOpportunity"]>[0]> = {}): Promise<Opportunity> {
  const { opportunity: o } = await store.upsertOpportunity(
    { coin: "ETH", direction: "long", setupKind: "breakout", tradeType: "directional", score: 2.5, scoreVersion: "v1", tags: ["oi_up"], liquidityTier: 1, regime: "new_longs", invalidation: "15m close below 3800", entryPx: 4000, stopPx: 3800, targetPx: 4400, invalidationPx: 3800, ...over },
    created,
  );
  await store.setOpportunityCosts(o.id, costs);
  if (status === "new") return (await store.getOpportunity(o.id))!;
  await store.transitionOpportunity(o.id, "new", "calculated", "system");
  return (await store.transitionOpportunity(o.id, "calculated", "ready", "system"))!;
}

beforeEach(() => {
  store = new MemoryPlatformStore();
  midAge = 1;
  lastScan = new Date(NOW.getTime() - 10_000);
  nearMisses = [];
  online = true;
  risk = gate();
  ctx = { store, midAge: () => midAge, mid: (coin) => (coin === "ETH" ? 4000 : null), lastScanAt: async () => lastScan, nearMisses: async () => nearMisses, scanIntervalSec: 60 };
  deps = { context: () => (online ? ctx : null), risk, research, now: () => NOW };
  app = new Hono().basePath("/api").route("/platform", createPlatformRoutes(deps));
});

describe("offline", () => {
  test("every route answers 503 platform_offline without a context", async () => {
    online = false;
    const id = crypto.randomUUID();
    for (const [method, path] of [["GET", "/opportunities"], ["GET", `/opportunities/${id}`], ["POST", `/opportunities/${id}/approve`], ["POST", `/opportunities/${id}/reject`], ["POST", `/opportunities/${id}/snooze`], ["POST", `/opportunities/${id}/research`], ["GET", "/liqmap?coin=ETH"], ["GET", "/liqmap/board"], ["GET", "/liqmap/history?coin=ETH"], ["GET", "/novelty"], ["GET", "/near-miss"], ["GET", "/ledger/stats"], ["GET", `/ledger/${id}`]] as const) {
      const res = await req(path, { method });
      expect([method, path, res.status]).toEqual([method, path, 503]);
      expect(await res.json()).toEqual({ error: "platform_offline" });
    }
  });
});

describe("feed and detail", () => {
  test("feed is sorted by score, filters by status and parses", async () => {
    await seed("ready", { score: 1 });
    await seed("ready", { coin: "BTC", score: 3, entryPx: 60000, stopPx: 59000, targetPx: 62000, invalidationPx: 59000 });
    await seed("new", { coin: "SOL", score: 2, entryPx: 150, stopPx: 140, targetPx: 170, invalidationPx: 140 });
    const all = FeedResponseSchema.parse(await (await req("/opportunities")).json());
    expect(all.opportunities.map((o) => o.coin)).toEqual(["BTC", "SOL", "ETH"]);
    expect(all.scanAgeSec).toBe(10);
    expect(all.readyTtlMin).toBe(60);
    const ready = FeedResponseSchema.parse(await (await req("/opportunities?status=ready,approved&limit=1")).json());
    expect(ready.opportunities.map((o) => o.coin)).toEqual(["BTC"]);
    expect(FeedResponseSchema.parse(await (await req("/opportunities?tier=2")).json()).opportunities).toHaveLength(0);
  });

  test("bad query → 400 naming the field", async () => {
    const res = await req("/opportunities?status=bogus");
    expect(res.status).toBe(400);
    expect((await req("/opportunities?limit=0")).status).toBe(400);
    expect(await (await req("/opportunities?nope=1")).json()).toMatchObject({ error: expect.any(String) });
    expect((await req("/liqmap?coin=ETH&bucketBps=0")).status).toBe(400);
    expect(await (await req("/liqmap?coin=ETH&bucketBps=0")).json()).toMatchObject({ field: "bucketBps" });
  });

  test("detail: signals, costs, stats, risk before/after and a governor-sized ticket", async () => {
    const o = await seed();
    await store.appendLedger({ opportunityId: o.id, kind: "outcome", payload: { horizon: "1h", entryBasis: "mark", entryPx: 4000, horizonPx: 4040, grossReturn: 0.01, netReturn: 0.009 } });
    const d = OpportunityDetailSchema.parse(await (await req(`/opportunities/${o.id}`)).json());
    expect(d.evidence).toBe("ledger 24h: n 0 · 0 clusters · edge unvalidated");
    // z-features carry their raw input as value (none for priceAccelZ); plain features carry themselves.
    expect(d.signals).toEqual([{ name: "ret15mZ", value: 0.012, z: 2.1 }, { name: "priceAccelZ", value: null, z: 1.2 }, { name: "fundingPctile14d", value: 0.9, z: null }]);
    expect(d.opportunity.costs?.absorbableUsd).toBe(50_000);
    expect(d.opportunity.invalidation).toBe("15m close below 3800");
    expect(d.stats).toMatchObject({ setupKind: "breakout", n: 1 });
    expect(d.risk?.after.approved).toBe(true);
    expect(d.ticket).toEqual({ side: "long", entryPx: 4000, stopPx: 3800, targetPx: 4400, sizeUsd: 1000, sizeSource: "governor" });
    expect(d.bearCase).toBeNull();
  });

  test("detail: a failing governor preview gives risk null and no size, not a 500", async () => {
    deps.risk = gate({ assess: async () => { throw new Error("desk down"); } });
    const o = await seed();
    const orig = console.error;
    console.error = () => {};
    const d = OpportunityDetailSchema.parse(await (await req(`/opportunities/${o.id}`)).json());
    console.error = orig;
    expect(d.risk).toBeNull();
    expect(d.ticket.sizeUsd).toBeNull();
  });

  test("detail: bear case from the attached research; 404 and bad id", async () => {
    const o = await seed();
    await store.appendLedger({ opportunityId: o.id, kind: "research", payload: { researchId: "r1", model: "m", promptVersion: "research-v2", sources: [] } });
    deps.research = { ...research, get: async () => ({ id: "r1", status: "found", explanation: "Unlock next week." }) as never };
    expect(((await (await req(`/opportunities/${o.id}`)).json()) as { bearCase: string }).bearCase).toBe("Unlock next week.");
    expect((await req(`/opportunities/${crypto.randomUUID()}`)).status).toBe(404);
    expect((await req("/opportunities/nope")).status).toBe(400);
  });
});

describe("near-miss", () => {
  test("top is the first of all; empty scan gives null", async () => {
    expect(NearMissResponseSchema.parse(await (await req("/near-miss")).json())).toEqual({ top: null, all: [] });
    nearMisses = [{ coin: "ETH", setupKind: "crowded_long", cond: 2, value: 0.95, limit: 1, relDistance: 0.05 }, { coin: "SOL", setupKind: "crowded_long", cond: 2, value: 0.92, limit: 1, relDistance: 0.08 }];
    const r = NearMissResponseSchema.parse(await (await req("/near-miss")).json());
    expect(r.top?.coin).toBe("ETH");
    expect(r.all).toHaveLength(2);
  });
});

describe("DB-only context (no worker, as on Vercel)", () => {
  test("the default deps find the database under the Supabase integration's variable name", () => {
    // Vercel's Supabase integration sets DATABASE_POSTGRES_URL, never DATABASE_URL: the context must come up anyway.
    const keys = ["DATABASE_URL", "DATABASE_POSTGRES_URL", "POSTGRES_URL"] as const;
    const saved = keys.map((k) => process.env[k]);
    try {
      for (const k of keys) delete process.env[k];
      expect(defaultPlatformDeps().context()).toBeNull();
      process.env.DATABASE_POSTGRES_URL = "postgres://u@127.0.0.1:1/db"; // never dialled: the store connects lazily
      expect(defaultPlatformDeps().context()).not.toBeNull();
    } finally {
      keys.forEach((k, i) => (saved[i] === undefined ? delete process.env[k] : (process.env[k] = saved[i])));
    }
  });

  test("serves the persisted near-miss and the feed; approval stays blocked", async () => {
    const nm = { coin: "ETH", setupKind: "crowded_long", cond: 2, value: 0.95, limit: 1, relDistance: 0.05 };
    await store.saveNearMisses(new Date(NOW.getTime() - 600_000).toISOString(), [nm]);
    const o = await seed();
    const dbApp = new Hono().basePath("/api").route("/platform", createPlatformRoutes({ ...deps, context: () => dbPlatformContext(store) }));
    const get = (path: string) => dbApp.request(`/api/platform${path}`);
    expect(NearMissResponseSchema.parse(await (await get("/near-miss")).json())).toEqual({ top: nm, all: [nm] });
    const feed = await get("/opportunities");
    expect(feed.status).toBe(200);
    expect((await feed.json() as { scanAgeSec: number }).scanAgeSec).toBe(600);
    const r = await dbApp.request(`/api/platform/opportunities/${o.id}/approve`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(r.status).toBe(409);
    expect((await r.json() as { error: string }).error).toBe("stale_feed");
  });
});

describe("novelty", () => {
  const nov = (barDate: string, coin: string) => ({
    id: `${barDate}:${coin}`, detectedAt: NOW.toISOString(), barDate, coin, kind: "new_extreme" as const, families: ["funding" as const], nearSetups: [], marketWide: false, pushed: true, notified: [],
    features: [{ id: "funding_z90", value: 9, histMin: -3, histMax: 8, p1: -2, p99: 3, bars: 400, pctRank: 100 }],
  });
  test("newest bar first, within days, optional coin filter; bad query is 400", async () => {
    await store.saveNovelty([nov("2026-10-15", "ETH"), nov("2026-10-15", "BTC"), nov("2026-10-10", "BTC"), nov("2026-08-01", "BTC")]);
    const all = NoveltyResponseSchema.parse(await (await req("/novelty?days=10")).json());
    expect(all.entries.map((e) => e.id)).toEqual(["2026-10-15:ETH", "2026-10-15:BTC", "2026-10-10:BTC"]);
    expect(NoveltyResponseSchema.parse(await (await req("/novelty?days=10&coin=ETH")).json()).entries).toHaveLength(1);
    expect((await req("/novelty?days=0")).status).toBe(400);
  });
});

describe("approve", () => {
  test("freshness gate: stale mid, no mid, or old scan → 409 stale_feed, nothing placed", async () => {
    const o = await seed();
    for (const set of [() => (midAge = 31), () => ((midAge = null)), () => ((midAge = 1), (lastScan = new Date(NOW.getTime() - 121_000))), () => (lastScan = null)]) {
      set();
      const res = await post(`/opportunities/${o.id}/approve`);
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: "stale_feed", message: expect.any(String) });
    }
    expect(risk.placed).toBe(0);
    expect((await store.getOpportunity(o.id))?.status).toBe("ready");
  });

  test("happy path: decision entry with seen, ready → approved → open", async () => {
    const o = await seed();
    const res = await post(`/opportunities/${o.id}/approve`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ opportunity: { status: "open" }, proposalId: "p1" });
    const entries = LedgerEntriesResponseSchema.parse(await (await req(`/ledger/${o.id}`)).json()).entries;
    const dec = entries.find((e) => e.kind === "decision");
    expect(dec?.payload).toMatchObject({ decision: "approve", operator: "operator", seen: { score: 2.5, scoreVersion: "v1", stopPx: 3800, features: { features: { ret15mZ: 2.1 } }, costs: { feeBps: 4.5 } } });
    expect(entries.filter((e) => e.kind === "status").map((e) => (e.payload as { to: string }).to)).toEqual(["calculated", "ready", "approved", "open"]);
    expect(entries.filter((e) => e.kind === "status").at(-1)!.payload).toMatchObject({ to: "open", ref: "p1" });
    expect(risk.placed).toBe(1);
  });

  test("governor block → 422 with its reasons, no transition, nothing placed", async () => {
    deps.risk = gate({ assess: async () => ({ before: { approved: true, reasons: [], warnings: [] }, after: { approved: false, reasons: ["kill switch is on: no new entries"], warnings: [] } }) });
    const o = await seed();
    const res = await post(`/opportunities/${o.id}/approve`);
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "governor_blocked", reasons: ["kill switch is on: no new entries"] });
    expect((await store.getOpportunity(o.id))?.status).toBe("ready");
    expect((await store.ledgerFor(o.id)).some((e) => e.kind === "decision")).toBe(false);
  });

  test("a block at placement time ends failed (system, ref, reason), with only the approve decision", async () => {
    deps.risk = gate({ place: async () => ({ status: "blocked", reasons: ["mark moved"], proposalId: "p2" }) });
    const o = await seed();
    expect((await post(`/opportunities/${o.id}/approve`)).status).toBe(422);
    expect((await store.getOpportunity(o.id))?.status).toBe("failed");
    const entries = await store.ledgerFor(o.id);
    expect(entries.at(-1)!.payload).toEqual({ from: "approved", to: "failed", actor: "system", ref: "p2", reason: "placement blocked: mark moved" });
    expect(entries.filter((e) => e.kind === "decision").map((e) => (e.payload as { decision: string }).decision)).toEqual(["approve"]);
  });

  test("D1: a slow placement is in flight; a reconcile tick meanwhile leaves it approved, then it opens", async () => {
    let release!: () => void;
    const gateP = new Promise<void>((r) => (release = r));
    let by = "";
    deps.risk = gate({ place: async (_t, b) => ((by = b), await gateP, { status: "executed", reasons: [], proposalId: "p9" }) });
    const o = await seed();
    const pending = post(`/opportunities/${o.id}/approve`);
    while (!by) await new Promise((r) => setTimeout(r, 1));
    expect(by).toContain(o.id); // the opportunity id rides on the desk proposal
    store.opportunities.get(o.id)!.statusChangedAt = new Date(Date.now() - 60 * 60_000).toISOString();
    const desk = { store: { getProposal: async () => null, listProposals: async () => [], paperPositions: async () => [] }, broker: { live: false }, account: async () => { throw new Error("unused"); }, alert: async () => {} };
    expect(await reconcileOnce({ store, desk: () => desk, now: () => new Date() })).toEqual([]);
    expect((await store.getOpportunity(o.id))?.status).toBe("approved");
    release();
    expect(await (await pending).json()).toMatchObject({ opportunity: { status: "open" }, proposalId: "p9" });
  });

  test("a placement that throws ends failed with ref null and 502", async () => {
    deps.risk = gate({ place: async () => { throw new Error("venue down"); } });
    const o = await seed();
    expect((await post(`/opportunities/${o.id}/approve`)).status).toBe(502);
    expect((await store.getOpportunity(o.id))?.status).toBe("failed");
    expect((await store.ledgerFor(o.id)).at(-1)!.payload).toMatchObject({ to: "failed", ref: null, reason: "placement failed: venue down" });
  });

  test("approved → open lost after a fill: 500 transition_lost, row stays approved for reconcile", async () => {
    const o = await seed();
    const orig = store.transitionOpportunity.bind(store);
    store.transitionOpportunity = async (...a) => (a[2] === "open" ? null : orig(...a));
    const err = console.error;
    console.error = () => {};
    const res = await post(`/opportunities/${o.id}/approve`);
    console.error = err;
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: "transition_lost", proposalId: "p1" });
    expect((await store.getOpportunity(o.id))?.status).toBe("approved");
  });

  test("not ready → 409 illegal_transition; unknown → 404", async () => {
    const o = await seed("new");
    const res = await post(`/opportunities/${o.id}/approve`);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "illegal_transition" });
    expect((await post(`/opportunities/${crypto.randomUUID()}/approve`)).status).toBe(404);
  });

  test("through the real desk: governor sizes it and the paper book gets the fill", async () => {
    const kit = makeService();
    deps.risk = deskRisk(() => kit.service);
    const o = await seed();
    const d = OpportunityDetailSchema.parse(await (await req(`/opportunities/${o.id}`)).json());
    expect(d.risk?.after.approved).toBe(true);
    expect(d.ticket.sizeUsd).toBeGreaterThan(0);
    const res = await post(`/opportunities/${o.id}/approve`);
    expect(await res.json()).toMatchObject({ opportunity: { status: "open" } });
    expect(await kit.store.listFills(10)).toHaveLength(1);
  });

  test("through the real desk: a fill whose desk record write throws still ends open", async () => {
    const kit = makeService();
    kit.store.updateProposal = async () => { throw new Error("db down"); };
    deps.risk = deskRisk(() => kit.service);
    const o = await seed();
    const err = console.error;
    console.error = () => {};
    const res = await post(`/opportunities/${o.id}/approve`);
    console.error = err;
    expect(await res.json()).toMatchObject({ opportunity: { status: "open" } });
    expect(await kit.store.paperPositions()).toHaveLength(1);
  });

  test("through the real desk: kill switch blocks with 422 before anything is placed", async () => {
    const kit = makeService();
    await kit.service.setKillSwitch(true, "test", "test");
    deps.risk = deskRisk(() => kit.service);
    const o = await seed();
    const res = await post(`/opportunities/${o.id}/approve`);
    expect(res.status).toBe(422);
    expect(((await res.json()) as { reasons: string[] }).reasons.join()).toContain("kill switch");
    expect(await kit.store.listFills(10)).toHaveLength(0);
  });
});

describe("reject, snooze, research", () => {
  test("reject needs a non-empty reason (400), then writes decision + seen", async () => {
    const o = await seed();
    for (const b of [{}, { reason: "  " }, { reason: "x", extra: 1 }]) expect((await post(`/opportunities/${o.id}/reject`, b)).status).toBe(400);
    expect(await (await post(`/opportunities/${o.id}/reject`, {})).json()).toMatchObject({ field: "reason" });
    const res = await post(`/opportunities/${o.id}/reject`, { reason: "funding too hot" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ opportunity: { status: "rejected" } });
    const dec = (await store.ledgerFor(o.id)).find((e) => e.kind === "decision");
    expect(dec?.payload).toMatchObject({ decision: "reject", reason: "funding too hot", seen: { score: 2.5 } });
  });

  test("reject only from ready: an approved idea → 409", async () => {
    const o = await seed();
    await store.transitionOpportunity(o.id, "ready", "approved", "operator", { decision: "approve", reason: null, operator: "operator", seen: { score: 1, scoreVersion: "v1", features: { features: {}, inputs: {} }, stopPx: null, targetPx: null, invalidationPx: null, regime: "r", liquidityTier: 1, costs: null } });
    const res = await post(`/opportunities/${o.id}/reject`, { reason: "changed my mind" });
    expect(res.status).toBe(409);
    expect((await store.getOpportunity(o.id))?.status).toBe("approved");
  });

  test("illegal transition → 409 (reject a rejected idea, reject a new one)", async () => {
    const o = await seed();
    await post(`/opportunities/${o.id}/reject`, { reason: "no" });
    expect((await post(`/opportunities/${o.id}/reject`, { reason: "again" })).status).toBe(409);
    const n = await seed("new", { coin: "SOL", entryPx: 150, stopPx: 140, targetPx: 170, invalidationPx: 140 });
    expect((await post(`/opportunities/${n.id}/reject`, { reason: "early" })).status).toBe(409);
  });

  test("snooze sets snoozedUntil; bad minutes → 400", async () => {
    const o = await seed();
    const res = await post(`/opportunities/${o.id}/snooze`, { minutes: 30 });
    expect(await res.json()).toMatchObject({ opportunity: { snoozedUntil: new Date(NOW.getTime() + 30 * 60_000).toISOString(), status: "ready" } });
    expect((await post(`/opportunities/${o.id}/snooze`, { minutes: 0 })).status).toBe(400);
    expect((await post(`/opportunities/${o.id}/snooze`, { minutes: 1.5 })).status).toBe(400);
  });

  test("research: ledger entry with model, prompt version and sources; new → investigating", async () => {
    const o = await seed("new");
    deps.research = { ...research, run: async () => ({ id: "r9", status: "found", model: "claude-x", explanation: "e", evidence: [{ claim: "c", url: "https://a.example/x", ts: null, type: "observed" }, { claim: "d", url: "https://a.example/x", ts: null, type: "observed" }] }) as never };
    const res = await post(`/opportunities/${o.id}/research`);
    expect(await res.json()).toMatchObject({ opportunity: { status: "investigating" }, research: { id: "r9" } });
    expect((await store.ledgerFor(o.id)).find((e) => e.kind === "research")?.payload).toEqual({ researchId: "r9", model: "claude-x", promptVersion: "research-v2", sources: ["https://a.example/x"] });
  });

  test("research: a ready idea keeps its status; capped → 429; in flight → 409", async () => {
    const o = await seed();
    deps.research = { ...research, run: async () => ({ id: "r1", status: "no_cause", model: "m", explanation: "none", evidence: [] }) as never };
    expect(await (await post(`/opportunities/${o.id}/research`)).json()).toMatchObject({ opportunity: { status: "ready" } });
    deps.research = { ...research, run: async () => "capped" };
    expect((await post(`/opportunities/${o.id}/research`)).status).toBe(429);
    deps.research = { ...research, run: async () => null };
    expect((await post(`/opportunities/${o.id}/research`)).status).toBe(409);
  });
});

describe("liqmap and ledger", () => {
  test("liqmap: long below mark, short above, coverage from the scan OI; cached for 10 s", async () => {
    await store.savePoll(ADDR, NOW.toISOString(), [{ coin: "ETH", szi: 100, entryPx: 3900, positionValue: 400_000, liquidationPx: 3600, leverage: 10 }]);
    await store.savePoll(`0x${"b".repeat(40)}`, NOW.toISOString(), [{ coin: "ETH", szi: -50, entryPx: 4100, positionValue: 200_000, liquidationPx: 4400, leverage: 10 }]);
    await store.insertScanSnapshots([{ coin: "ETH", ts: new Date(NOW.getTime() - 60_000).toISOString(), inputs: { mark: 3990, oiUsd: 3_000_000 } }]);
    const m = LiqMapResponseSchema.parse(await (await req("/liqmap?coin=ETH&range=0.2&bucketBps=50")).json());
    expect(m.mark).toBe(4000);
    expect(m.buckets.some((b) => b.longUsd === 400_000 && b.priceHi < 4000)).toBe(true);
    expect(m.buckets.some((b) => b.shortUsd === 200_000 && b.priceLo > 4000)).toBe(true);
    expect(m.coverage).toMatchObject({ trackedNotional: 600_000, oiNotional: 3_000_000, addresses: 2 });
    expect(m.nearestClusters.long).toMatchObject({ notionalUsd: 400_000 });
    expect(m.nearestClusters.short).toBeNull(); // 200k is under the cluster floor
    await store.savePoll(ADDR, NOW.toISOString(), []);
    expect(((await (await req("/liqmap?coin=ETH&range=0.2&bucketBps=50")).json()) as { coverage: { addresses: number } }).coverage.addresses).toBe(2);
    expect(((await (await req("/liqmap?coin=ETH&range=0.2&bucketBps=25")).json()) as { coverage: { addresses: number } }).coverage.addresses).toBe(1);
  });

  test("liqmap board: top coins by scan OI, nearest clusters, sorted by the nearer cluster; cached", async () => {
    await store.savePoll(ADDR, NOW.toISOString(), [
      { coin: "ETH", szi: 100, entryPx: 3900, positionValue: 400_000, liquidationPx: 3600, leverage: 10 },
      { coin: "BTC", szi: -10, entryPx: 60000, positionValue: 600_000, liquidationPx: 61000, leverage: 10 },
    ]);
    const ts = new Date(NOW.getTime() - 60_000).toISOString();
    await store.insertScanSnapshots([
      { coin: "ETH", ts, inputs: { mark: 3990, oiUsd: 3_000_000 } },
      { coin: "BTC", ts, inputs: { mark: 60000, oiUsd: 9_000_000 } },
      { coin: "SOL", ts, inputs: { mark: 150, oiUsd: 1_000 } },
    ]);
    const b = LiqBoardResponseSchema.parse(await (await req("/liqmap/board")).json());
    expect(b.rows.map((r) => r.coin)).toEqual(["BTC", "ETH", "SOL"]); // BTC 1.7% away, ETH 10%, SOL none
    expect(b.rows[0]).toMatchObject({ mark: 60000, nearestLong: null, nearestShort: { notionalUsd: 600_000 }, coverage: { addresses: 1 } });
    expect(b.rows[1]!.mark).toBe(4000); // live mid wins over the snapshot
    expect(LiqBoardResponseSchema.parse(await (await req("/liqmap/board?limit=1")).json()).rows.map((r) => r.coin)).toEqual(["BTC"]);
    expect((await req("/liqmap/board?limit=0")).status).toBe(400);
  });

  test("liqmap: no mark anywhere → 503 no_mark; history parses", async () => {
    expect(await (await req("/liqmap?coin=DOGE")).json()).toMatchObject({ error: "no_mark" });
    await store.insertLiqmapSnapshots([{ coin: "ETH", ts: new Date(NOW.getTime() - 3_600_000).toISOString(), mark: 4000, bucketBps: 25, buckets: [{ idx: 1, longUsd: 5, shortUsd: 0 }] }]);
    const h = LiqMapHistoryResponseSchema.parse(await (await req("/liqmap/history?coin=ETH&hours=2")).json());
    expect(h.snapshots).toHaveLength(1);
    expect((await req("/liqmap/history?coin=ETH&hours=0")).status).toBe(400);
  });

  test("ledger stats and entries parse; unknown opportunity 404", async () => {
    const o = await seed();
    await store.appendLedger({ opportunityId: o.id, kind: "outcome", payload: { horizon: "1h", entryBasis: "mark", entryPx: 4000, horizonPx: 4040, grossReturn: 0.01, netReturn: 0.009 } });
    const s = LedgerStatsResponseSchema.parse(await (await req("/ledger/stats?setupKind=breakout")).json());
    expect(s.stats).toMatchObject([{ setupKind: "breakout", horizon: "1h", n: 1, regime: null }]);
    expect(LedgerStatsResponseSchema.parse(await (await req("/ledger/stats?regime=new_longs&tier=1")).json()).stats[0]).toMatchObject({ regime: "new_longs", tier: 1 });
    expect((await req("/ledger/stats?tier=9")).status).toBe(400);
    expect(LedgerEntriesResponseSchema.parse(await (await req(`/ledger/${o.id}`)).json()).entries.length).toBeGreaterThan(2);
    expect((await req(`/ledger/${crypto.randomUUID()}`)).status).toBe(404);
  });
});

describe("auth", () => {
  test("read bearer opens GETs under /platform, never POSTs", async () => {
    const saved = [process.env.LAB_API_TOKEN, process.env.SESSION_SECRET];
    process.env.LAB_API_TOKEN = "tok";
    process.env.SESSION_SECRET = "s";
    const a = new Hono().basePath("/api");
    a.use("*", requireAuth);
    a.route("/platform", createPlatformRoutes(deps));
    const h = { authorization: "Bearer tok" };
    expect((await a.request("/api/platform/opportunities", { headers: h })).status).toBe(200);
    expect((await a.request("/api/platform/opportunities")).status).toBe(401);
    expect((await a.request(`/api/platform/opportunities/${crypto.randomUUID()}/approve`, { method: "POST", headers: h })).status).toBe(401);
    [process.env.LAB_API_TOKEN, process.env.SESSION_SECRET] = saved;
  });
});

describe("/api/health", () => {
  test("without a session: loop names and ok plus ws only; with one: everything", async () => {
    process.env.SESSION_SECRET = process.env.SESSION_SECRET || "s";
    setHealthExtras(() => ({
      store: "memory", loops: [{ name: "scanner", lastBeatAt: null, expectedIntervalSec: 60, ok: false, error: "boom at db" }],
      ws: { state: "open", lastMessageAgeSec: 1 }, crawler: { pollsPerMin: 5, addresses: 99 }, scanAgeSec: 3, llmSpendUsdToday: null,
    }));
    try {
      const anon = (await (await apiApp.request("/api/health")).json()) as Record<string, unknown>;
      expect(Object.keys(anon).sort()).toEqual(["loops", "ok", "ts", "ws"]);
      expect(anon.loops).toEqual([{ name: "scanner", ok: false }]);
      const full = (await (await apiApp.request("/api/health", { headers: { cookie: `ht_session=${signSession()}` } })).json()) as Record<string, unknown>;
      expect(full).toMatchObject({ crawler: { addresses: 99 }, loops: [{ error: "boom at db" }] });
    } finally {
      setHealthExtras(null);
    }
  });
});
