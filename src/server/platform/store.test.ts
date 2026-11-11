import { beforeAll, describe, expect, test } from "bun:test";
import type { AgentRecord, TriageItem } from "../../shared/agentRecords.js";
import type { MovesResponse } from "../../shared/moves.js";
import type { LedgerPayload, NoveltyEntry } from "../../shared/platform.js";
import { row as moveRow } from "../moves/agent.fixture.js";
import { migrate } from "../../../db/migrate.js";
import { newPglite, pgliteDb } from "../testing/pglite.js";
import type { OpportunityInput, PlatformStore, PolledPosition } from "./store.js";
import { diffPositions, pollSummary } from "./store.js";
import { MemoryPlatformStore } from "./store-memory.js";
import { PgPlatformStore } from "./store-pg.js";

// Store parity: one scenario through MemoryPlatformStore and PgPlatformStore
// (011_platform.sql on PGlite, applied by db/migrate.ts). The assertions run
// against both, then their normalized outputs must match call for call.

const A1 = `0x${"a".repeat(40)}`;
const A2 = `0x${"b".repeat(40)}`;
const A3 = `0x${"c".repeat(40)}`;
const t = (h: number) => new Date(Date.UTC(2026, 9, 16, h)).toISOString();

const btc = (szi: number, liq: number | null): PolledPosition => ({ coin: "BTC", szi, entryPx: 60000, positionValue: Math.abs(szi) * 62000, liquidationPx: liq, leverage: 5 });
const eth = (szi: number, liq: number | null): PolledPosition => ({ coin: "ETH", szi, entryPx: 3000, positionValue: Math.abs(szi) * 3100, liquidationPx: liq, leverage: 10 });

const opp = (over: Partial<OpportunityInput> = {}): OpportunityInput => ({
  coin: "BTC", direction: "long", setupKind: "breakout", tradeType: "directional", score: 2, scoreVersion: "v1",
  tags: ["oi_up"], liquidityTier: 1, regime: "new_longs", invalidation: "15m close below 61k",
  entryPx: 62000, stopPx: 61000, targetPx: 64000, invalidationPx: 61000, ...over,
});
const created = (score: number): LedgerPayload<"created"> => ({
  features: { features: { ret15m: 1.2, fundingZ: null }, inputs: { mark: 62000, oi: [1, null, 2], regime: "new_longs", ctx: { premium: null, ok: true } } },
  market: { mark: 62000 }, score, scoreVersion: "v1",
});
const costs: LedgerPayload<"costs"> = { feeBps: 4.5, slippageBps: 2, fundingBps: 1, absorbableUsd: 50000, grossEdgeBps: 30, netEdgeBps: 18, edgeBasis: "unvalidated" };
const outcome = (id: string): Extract<Parameters<PlatformStore["appendLedger"]>[0], { kind: "outcome" }> => ({
  opportunityId: id, kind: "outcome", payload: { horizon: "1h", entryBasis: "mark", entryPx: 62000, horizonPx: 62620, grossReturn: 0.01, netReturn: 0.0091 },
});

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** uuids → #1, #2… by first appearance; store-clock stamps (createdAt, updatedAt, statusChangedAt) checked as ISO and dropped. */
function normalizer() {
  const ids = new Map<string, string>();
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) {
        if (k === "createdAt" || k === "updatedAt" || k === "statusChangedAt") expect(x).toMatch(ISO);
        else out[k] = walk(x);
      }
      return out;
    }
    if (typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(v)) {
      if (!ids.has(v)) ids.set(v, `#${ids.size + 1}`);
      return ids.get(v);
    }
    return v;
  };
  return walk;
}

/** Every PlatformStore method, with the expected values asserted inline. */
async function scenario(s: PlatformStore): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const n = normalizer();
  const put = (k: string, v: unknown) => (out[k] = n(v));

  // address book
  expect(await s.recordAddresses([{ address: A1.toUpperCase().replace("0X", "0x"), seenAt: t(0) }, { address: A1, seenAt: t(1) }, { address: A2, seenAt: t(0) }, { address: "0xnope", seenAt: t(0) }])).toBe(2);
  expect(await s.recordAddresses([{ address: A1, seenAt: t(0) }])).toBe(1);
  const a1 = await s.getAddress(A1);
  expect(a1).toEqual({ address: A1, firstSeenAt: t(1), lastSeenAt: t(1), polledAt: null, notionalUsd: 0, positionCount: 0, minLiqDistance: null });
  expect(await s.getAddress(A3)).toBeNull();
  expect(await s.addressCount()).toBe(2);
  put("crawl.fresh", await s.crawlCandidates({ idleBefore: t(0), limit: 10 }));
  expect((out["crawl.fresh"] as { address: string }[]).map((a) => a.address)).toEqual([A1, A2]);

  // polls
  const open = await s.savePoll(A1, t(2), [btc(1, 50000), eth(-10, 3400)]);
  expect(open.map((c) => [c.coin, c.kind])).toEqual([["BTC", "open"], ["ETH", "open"]]);
  const a1p = (await s.getAddress(A1))!;
  expect(a1p).toMatchObject({ polledAt: t(2), notionalUsd: 62000 + 31000, positionCount: 2 });
  expect(a1p.minLiqDistance).toBeCloseTo(300 / 3100, 10);
  // BTC szi +0.5% and liq unchanged: no change; ETH liq +5%: change.
  const moved = await s.savePoll(A1, t(3), [btc(1.005, 50000), eth(-10, 3570)]);
  expect(moved.map((c) => [c.coin, c.kind])).toEqual([["ETH", "change"]]);
  const closed = await s.savePoll(A1, t(4), [eth(-10, 3570)]);
  expect(closed).toEqual([{ address: A1, coin: "BTC", ts: t(4), kind: "close", szi: null, liquidationPx: null, prevSzi: 1.005, prevLiquidationPx: 50000 }]);
  expect(await s.savePoll(A3, t(2), [])).toEqual([]);
  await expect(s.savePoll(A2, t(2), [eth(1, 2000), eth(2, 2000)])).rejects.toThrow(/duplicate/);
  await expect(s.savePoll(A2, t(2), [{ ...eth(1, 2000), entryPx: -1 }])).rejects.toThrow();
  await expect(s.savePoll(A2, t(2), [{ ...eth(1, 2000), szi: 0 }])).rejects.toThrow();
  await expect(s.savePoll(A2, t(2), [{ ...eth(1, 2000), liquidationPx: Number.NaN }])).rejects.toThrow();
  expect((await s.getAddress(A2))!.polledAt).toBeNull();
  put("changes", await s.positionChanges(A1));
  expect((out.changes as unknown[]).length).toBe(4);
  put("positions.all", await s.listPositions());
  put("positions.eth", await s.listPositions("ETH"));
  expect(await s.listPositions("BTC")).toEqual([]);
  expect(await s.addressCount()).toBe(3);
  // A2 unpolled, A3 idle (polled t2 < t3, no positions), A1 holds a position.
  put("crawl.idle", await s.crawlCandidates({ idleBefore: t(3), limit: 10 }));
  expect((out["crawl.idle"] as { address: string }[]).map((a) => a.address)).toEqual([A2, A3, A1]);
  expect((await s.crawlCandidates({ idleBefore: t(1), limit: 10 })).map((a) => a.address)).toEqual([A2, A1]);
  expect((await s.crawlCandidates({ idleBefore: t(1), limit: 1 })).map((a) => a.address)).toEqual([A2]);
  // A3 trades again: back in the fast tier.
  await s.recordAddresses([{ address: A3, seenAt: t(5) }]);
  expect((await s.crawlCandidates({ idleBefore: t(1), limit: 10 })).map((a) => a.address)).toEqual([A2, A3, A1]);

  // snapshots
  const cells = [{ idx: 10, longUsd: 5, shortUsd: 0 }];
  expect(await s.insertLiqmapSnapshots([
    { coin: "BTC", ts: t(0), mark: 60000, bucketBps: 25, buckets: cells },
    { coin: "BTC", ts: t(1), mark: 61000, bucketBps: 25, buckets: cells },
    { coin: "ETH", ts: t(0), mark: 3000, bucketBps: 25, buckets: [] },
  ])).toBe(3);
  expect(await s.insertLiqmapSnapshots([{ coin: "BTC", ts: t(1), mark: 61500, bucketBps: 25, buckets: [] }])).toBe(1);
  put("liqmap.history", await s.liqmapHistory("BTC", t(0)));
  expect(await s.liqmapHistory("BTC", t(1))).toEqual([{ coin: "BTC", ts: t(1), mark: 61500, bucketBps: 25, buckets: [] }]);
  expect(await s.insertScanSnapshots([{ coin: "ETH", ts: t(1), inputs: { mark: 3000 } }, { coin: "BTC", ts: t(1), inputs: { mark: 61000 } }, { coin: "BTC", ts: t(0), inputs: {} }])).toBe(3);
  put("scan.since", await s.scanSnapshotsSince(t(1)));
  expect((out["scan.since"] as { coin: string }[]).map((r) => r.coin)).toEqual(["BTC", "ETH"]);
  expect((await s.scanSnapshotsSince(t(0), ["ETH"])).map((r) => r.coin)).toEqual(["ETH"]);
  expect((await s.scanSnapshotsSince(t(0), ["BTC", "SOL"])).map((r) => `${r.coin}@${r.ts}`)).toEqual([`BTC@${t(0)}`, `BTC@${t(1)}`]);
  expect(await s.scanSnapshotsSince(t(0), [])).toEqual([]);
  expect(await s.scanTickCount(t(0))).toBe(2); // distinct timestamps, not rows
  expect(await s.scanTickCount(t(1))).toBe(1);

  // opportunities
  const first = await s.upsertOpportunity(opp(), created(2));
  expect(first.created).toBe(true);
  expect(first.opportunity).toMatchObject({ status: "new", edgeBasis: "unvalidated", netEdgeBps: null, costs: null, dedupeKey: "BTC|long|breakout", snoozedUntil: null });
  const rescan = await s.upsertOpportunity(opp({ score: 3, entryPx: 1, tags: ["oi_up", "funding"] }), created(3));
  expect(rescan.created).toBe(false);
  expect(rescan.opportunity).toMatchObject({ id: first.opportunity.id, score: 3, entryPx: 62000, tags: ["oi_up", "funding"] });
  expect(rescan.opportunity.statusChangedAt).toBe(first.opportunity.statusChangedAt);
  expect(first.opportunity.statusChangedAt).toBe(first.opportunity.createdAt);
  // JSON-safe payloads: a non-finite number is refused before anything is written.
  const nan = created(9);
  nan.features.inputs.mark = Number.NaN;
  await expect(s.upsertOpportunity(opp({ setupKind: "nan" }), nan)).rejects.toThrow();
  await expect(s.upsertOpportunity(opp({ setupKind: "inf" }), { ...created(9), market: { mark: Infinity } })).rejects.toThrow();
  expect((await s.listOpportunities({ limit: 10 })).map((o) => o.setupKind)).toEqual(["breakout"]);
  const o1 = first.opportunity.id;
  const o2 = (await s.upsertOpportunity(opp({ coin: "ETH", direction: "short", score: 5, liquidityTier: 2 }), created(5))).opportunity.id;
  put("opp.upserts", [first, rescan]);
  expect((await s.listOpportunities({ limit: 10 })).map((o) => o.id)).toEqual([o2, o1]);
  expect((await s.listOpportunities({ limit: 1 })).map((o) => o.id)).toEqual([o2]);
  expect((await s.listOpportunities({ tier: 1, limit: 10 })).map((o) => o.id)).toEqual([o1]);
  expect(await s.listOpportunities({ statuses: ["ready"], limit: 10 })).toEqual([]);
  expect(await s.getOpportunity(crypto.randomUUID())).toBeNull();
  expect(await s.getOpportunity("not-a-uuid")).toBeNull();

  await expect(s.transitionOpportunity(o1, "new", "ready", "system")).rejects.toThrow(/illegal/);
  expect(await s.transitionOpportunity(o1, "calculated", "ready", "system")).toBeNull(); // not at `from`
  expect(await s.transitionOpportunity(crypto.randomUUID(), "new", "calculated", "system")).toBeNull();
  expect((await s.transitionOpportunity(o1, "new", "calculated", "system"))!.status).toBe("calculated");
  await s.transitionOpportunity(o1, "calculated", "ready", "system");
  const seen = { score: 3, scoreVersion: "v1", features: created(3).features, stopPx: 61000, targetPx: 64000, invalidationPx: 61000, regime: "new_longs", liquidityTier: 1 as const, costs: null };
  const reject: LedgerPayload<"decision"> = { decision: "reject", reason: "funding too hot", operator: "op", seen };
  const approve: LedgerPayload<"decision"> = { ...reject, decision: "approve", reason: null };
  await expect(s.transitionOpportunity(o1, "ready", "rejected", "system", reject)).rejects.toThrow(/operator/);
  await expect(s.transitionOpportunity(o1, "ready", "rejected", "operator")).rejects.toThrow(/decision/);
  await expect(s.transitionOpportunity(o1, "ready", "approved", "operator", reject)).rejects.toThrow(/decision/);
  await expect(s.transitionOpportunity(o1, "ready", "rejected", "operator", { ...reject, seen: { ...seen, score: Number.NaN } })).rejects.toThrow();
  // Missing id with a bad payload: the payload error wins in both stores.
  await expect(s.transitionOpportunity(crypto.randomUUID(), "ready", "rejected", "operator", { ...reject, operator: "" })).rejects.toThrow();
  await expect(s.setOpportunityCosts(crypto.randomUUID(), { ...costs, feeBps: -1 })).rejects.toThrow();
  await expect(s.appendLedger({ ...outcome(crypto.randomUUID()), payload: { ...outcome(o1).payload, horizonPx: 0 } })).rejects.toThrow(/horizonPx|too_small|greater/i);
  const beforeMove = (await s.getOpportunity(o1))!.statusChangedAt;
  await expect(s.transitionOpportunity(o1, "new", "calculated", "system", reject)).rejects.toThrow(/decision/);
  put("opp.rejected", await s.transitionOpportunity(o1, "ready", "rejected", "operator", reject));
  const rejected = (await s.getOpportunity(o1))!;
  expect(rejected.status).toBe("rejected");
  expect(rejected.statusChangedAt >= beforeMove).toBe(true);
  // Past the decision: no cost updates.
  expect(await s.setOpportunityCosts(o1, costs)).toBeNull();
  // The rejected one freed the dedupe slot.
  const again = await s.upsertOpportunity(opp(), created(2));
  expect(again.created).toBe(true);
  expect(again.opportunity.id).not.toBe(o1);
  put("opp.again", again);

  // An approved idea is frozen: a rescan returns it unchanged, with no ledger entry, and costs cannot move.
  const o3 = (await s.upsertOpportunity(opp({ coin: "SOL", score: 1 }), created(1))).opportunity.id;
  for (const [f, to] of [["new", "calculated"], ["calculated", "ready"]] as const) await s.transitionOpportunity(o3, f, to, "system");
  const approved = (await s.transitionOpportunity(o3, "ready", "approved", "operator", approve))!;
  const frozen = await s.upsertOpportunity(opp({ coin: "SOL", score: 7, stopPx: 1 }), created(7));
  expect(frozen).toEqual({ opportunity: approved, created: false });
  expect(await s.setOpportunityCosts(o3, costs)).toBeNull();
  put("ledger.o3", await s.ledgerFor(o3));
  expect((out["ledger.o3"] as { kind: string }[]).map((e) => e.kind)).toEqual(["created", "status", "status", "status", "decision"]);
  // Gate amendment: approved ends in open or failed (system only); rejected only from ready.
  await expect(s.transitionOpportunity(o3, "approved", "rejected", "operator", reject)).rejects.toThrow(/illegal/);
  await expect(s.transitionOpportunity(o3, "approved", "failed", "operator")).rejects.toThrow(/system/);
  expect(await s.lastTerminalAt("SOL|long|breakout")).toBeNull();
  put("opp.failed", await s.transitionOpportunity(o3, "approved", "failed", "system", undefined, { ref: null, reason: "placement failed: venue down" }));
  expect((await s.ledgerFor(o3)).at(-1)!.payload).toEqual({ from: "approved", to: "failed", actor: "system", ref: null, reason: "placement failed: venue down" });
  expect((await s.lastTerminalAt("SOL|long|breakout"))!.toISOString()).toBe((await s.getOpportunity(o3))!.statusChangedAt);
  expect(await s.lastTerminalAt("BTC|long|breakout")).toBeInstanceOf(Date);
  expect(await s.lastTerminalAt("nope")).toBeNull();
  expect(await s.transitionOpportunity("not-a-uuid", "approved", "failed", "system")).toBeNull();
  expect(await s.setOpportunityCosts("not-a-uuid", costs)).toBeNull();

  put("opp.costs", await s.setOpportunityCosts(o2, costs));
  expect((await s.getOpportunity(o2))!).toMatchObject({ costs: { feeBps: 4.5, slippageBps: 2, fundingBps: 1, absorbableUsd: 50000 }, grossEdgeBps: 30, netEdgeBps: 18 });
  expect(await s.setOpportunityCosts(crypto.randomUUID(), costs)).toBeNull();
  await expect(s.setOpportunityCosts(o2, { ...costs, feeBps: -1 })).rejects.toThrow();
  expect((await s.snoozeOpportunity(o2, t(6)))!.snoozedUntil).toBe(t(6));
  expect((await s.snoozeOpportunity(o2, null))!.snoozedUntil).toBeNull();
  expect(await s.snoozeOpportunity(crypto.randomUUID(), null)).toBeNull();
  expect((await s.listOpportunities({ statuses: ["rejected", "new"], limit: 10 })).map((o) => o.id)).toEqual([o2, o1, again.opportunity.id]);
  expect((await s.listOpportunities({ statuses: ["failed"], limit: 10 })).map((o) => o.id)).toEqual([o3]);

  // ledger
  put("ledger.research", await s.appendLedger({ opportunityId: o2, kind: "research", payload: { researchId: "r1", model: "m", promptVersion: "p1", sources: ["https://example.com/a"] } }));
  put("ledger.outcome", await s.appendLedger(outcome(o1)));
  expect(await s.appendLedger({ ...outcome(o1), payload: { ...outcome(o1).payload, horizonPx: 1 } })).toBeNull(); // one outcome per horizon
  await expect(s.appendLedger(outcome(crypto.randomUUID()))).rejects.toThrow(/unknown/);
  await expect(s.appendLedger({ ...outcome(o1), payload: { ...outcome(o1).payload, entryPx: -1 } })).rejects.toThrow();
  await expect(s.appendLedger({ opportunityId: o1, kind: "status", payload: { from: "new", to: "closed", actor: "system" } } as never)).rejects.toThrow(/research or outcome/);
  put("ledger.o1", await s.ledgerFor(o1));
  expect((out["ledger.o1"] as { kind: string }[]).map((e) => e.kind)).toEqual(["created", "status", "status", "status", "decision", "outcome"]);
  put("ledger.o2", await s.ledgerFor(o2));
  expect(await s.ledgerFor("not-a-uuid")).toEqual([]);
  expect(await s.outcomeRows({})).toEqual([{ opportunityId: o1, setupKind: "breakout", regime: "new_longs", scoreVersion: "v1", liquidityTier: 1, horizon: "1h", createdAtMs: expect.any(Number), grossReturn: 0.01, netReturn: 0.0091, hasCosts: false }]);
  expect(await s.outcomeRows({ setupKind: "breakout", regime: "new_longs", tier: 1 })).toHaveLength(1);
  expect(await s.outcomeRows({ tier: 2 })).toEqual([]);
  expect(await s.outcomeRows({ regime: "range" })).toEqual([]);

  // retention: BTC t0 + ETH t0 liqmaps, BTC t0 scan; changes are all at t2+. The ledger is untouched.
  expect(await s.pruneHistory(t(1))).toBe(3);
  expect(await s.pruneHistory(t(3), t(1))).toBe(1 + 2); // scans kept longer (PLATFORM_SCAN_RETENTION_DAYS): BTC t1 liqmap, two t2 opens
  expect(await s.pruneHistory(t(3))).toBe(2); // the two t1 scans
  expect((await s.ledgerFor(o1)).length).toBe(6);
  put("changes.after", await s.positionChanges(A1));

  // novelty journal: upsert by id (a delivery stamp replaces the entry), range read, bar-date prune
  const nov = (barDate: string, coin: string): NoveltyEntry => ({
    id: `${barDate}:${coin}`, detectedAt: t(0), barDate, coin, kind: "new_extreme", families: ["funding"], nearSetups: [], marketWide: false, pushed: true, notified: [],
    features: [{ id: "funding_z90", value: 9, histMin: -3, histMax: 8, p1: -2, p99: 3, bars: 400, pctRank: 100 }],
  });
  await s.saveNovelty([nov("2026-01-02", "ETH"), nov("2026-01-01", "BTC"), nov("2026-01-02", "BTC")]);
  await s.saveNovelty([{ ...nov("2026-01-02", "BTC"), notified: [{ at: t(1), channels: ["telegram"] }] }]);
  put("novelty.all", await s.listNovelty("2026-01-01"));
  expect((out["novelty.all"] as NoveltyEntry[]).map((e) => e.id)).toEqual(["2026-01-01:BTC", "2026-01-02:BTC", "2026-01-02:ETH"]);
  expect((out["novelty.all"] as NoveltyEntry[])[1]!.notified).toEqual([{ at: t(1), channels: ["telegram"] }]);
  expect((await s.listNovelty("2026-01-02")).length).toBe(2);
  expect(await s.pruneNovelty("2026-01-02")).toBe(1);

  // novelty pass progress: one row, replaced each save
  expect(await s.loadNoveltyProgress()).toBeNull();
  await s.saveNoveltyProgress({ pass: "2026-01-02", checked: { "2026-01-02": ["BTC"] }, pushed: 0, cursor: "BTC", at: t(1) });
  await s.saveNoveltyProgress({ pass: "2026-01-02", checked: { "2026-01-02": ["BTC", "ETH"], "2026-01-01": [] }, pushed: 1, cursor: null, at: t(2) });
  put("novelty.progress", await s.loadNoveltyProgress());
  expect(out["novelty.progress"]).toEqual({ pass: "2026-01-02", checked: { "2026-01-02": ["BTC", "ETH"], "2026-01-01": [] }, pushed: 1, cursor: null, at: t(2) });
  expect((await s.listNovelty("2026-01-01")).length).toBe(2);

  // near-miss row: empty before the first scan, then replaced wholesale
  expect(await s.latestNearMisses()).toBeNull();
  const nm = (coin: string) => ({ coin, setupKind: "crowded_long", cond: 2, value: 0.95, limit: 1, relDistance: 0.05 });
  await s.saveNearMisses(t(1), [nm("ETH"), nm("SOL")]);
  await s.saveNearMisses(t(2), [nm("BTC")]);
  put("nearMiss", await s.latestNearMisses());
  expect(out["nearMiss"]).toEqual({ ts: t(2), items: [nm("BTC")] });

  // agent watch (024): records with a compare-and-set patch, the daily run count, and the triage queue
  const rec = (id: string, coin: string, h: number, over: Partial<AgentRecord> = {}): AgentRecord => ({
    id, coin, createdAt: t(h), trigger: "triage",
    inputs: { window: "24h", residualPct: 6.2, residualZ: 3.1, totalPct: 4.5, markAtCreate: 10, btcAtCreate: 60000, asOf: t(h) },
    claim: "", assets: [coin], direction: null, horizonHours: 24, layer: "unexplained", falsifier: null, sources: [],
    status: "open", grade: null, model: "m", promptVersion: "moves-agent-v1", dropped: 0, error: null, ...over,
  });
  await s.insertAgentRecord(rec("r1", "SOL", 1));
  await s.insertAgentRecord(rec("r2", "ETH", 2, { status: "capped", model: null, error: "moves agent cap reached (6/6 today)" }));
  await s.insertAgentRecord(rec("r3", "SOL", 3, { status: "failed", model: null, error: "no LLM provider configured" }));
  await s.insertAgentRecord(rec("r4", "SOL", 3));
  await expect(s.insertAgentRecord(rec("r1", "SOL", 1))).rejects.toThrow();
  await expect(s.insertAgentRecord(rec("r5", "SOL", 1, { horizonHours: 5 as never }))).rejects.toThrow();
  expect(await s.agentRunsSince(t(0))).toBe(2); // r1, r4: capped and no-provider rows are not runs
  expect(await s.agentRunsSince(t(2))).toBe(1);
  const done = { claim: "Unlock of 3% of supply hit the order book.", direction: "short" as const, layer: "forced_flow" as const, status: "open" as const,
    falsifier: { level: 11, side: "above" as const, text: "above 11" }, sources: [{ url: "https://example.com/a", ts: null, title: "A", observed: true }] };
  put("agent.patched", await s.updateAgentRecord("r1", done, "open"));
  expect(out["agent.patched"]).toMatchObject({ id: "r1", claim: done.claim, falsifier: done.falsifier, inputs: { markAtCreate: 10 } });
  const grade = { atHours: 24, px: 9.5, btcPx: 60000, relPct: 5.13, hit: true, falsifiedAt: null };
  expect((await s.updateAgentRecord("r1", { status: "graded", grade }, "open"))!.status).toBe("graded");
  expect(await s.updateAgentRecord("r1", { status: "falsified" }, "open")).toBeNull(); // compare-and-set: no longer open
  expect(await s.updateAgentRecord("nope", { status: "failed" })).toBeNull();
  await expect(s.updateAgentRecord("r4", { claim: "x".repeat(401) })).rejects.toThrow();
  put("agent.all", await s.listAgentRecords({ limit: 10 }));
  expect((out["agent.all"] as AgentRecord[]).map((r) => r.id)).toEqual(["r3", "r4", "r2", "r1"]);
  expect((await s.listAgentRecords({ coin: "SOL", limit: 10 })).map((r) => r.id)).toEqual(["r3", "r4", "r1"]);
  expect((await s.listAgentRecords({ status: "open", limit: 10 })).map((r) => r.id)).toEqual(["r4"]);
  expect((await s.listAgentRecords({ since: t(2), limit: 2 })).map((r) => r.id)).toEqual(["r3", "r4"]);
  expect((await s.listAgentRecords({ coin: "SOL", limit: 1 }))[0]).toMatchObject({ id: "r3", error: "no LLM provider configured" });

  const item = (day: string, coin: string, score: number, over: Partial<TriageItem> = {}): TriageItem => ({
    id: `${day}:${coin}`, day, coin, reason: `residual +6.2% · z ${score} · 24h`, score, residualZ: score * 2.5, surfacedAt: t(1), dismissedAt: null, recordId: null, ...over,
  });
  await s.upsertTriageItem(item("2026-10-16", "SOL", 1.2));
  await s.upsertTriageItem(item("2026-10-16", "ETH", 1.2));
  await s.upsertTriageItem(item("2026-10-16", "WIF", 1.5));
  await s.upsertTriageItem(item("2026-10-17", "SOL", 2));
  await s.upsertTriageItem(item("2026-10-16", "SOL", 1.6, { recordId: "r1", surfacedAt: t(2) })); // re-surfaced: replaces the day's item
  await expect(s.upsertTriageItem(item("2026-10-16", "BAD", 1, { day: "16/10" }))).rejects.toThrow();
  put("triage.day", await s.listTriage("2026-10-16"));
  expect((out["triage.day"] as TriageItem[]).map((x) => [x.coin, x.score, x.recordId])).toEqual([["SOL", 1.6, "r1"], ["WIF", 1.5, null], ["ETH", 1.2, null]]);
  expect((await s.dismissTriage("2026-10-16:WIF", t(3)))!.dismissedAt).toBe(t(3));
  expect((await s.dismissTriage("2026-10-16:WIF", t(4)))!.dismissedAt).toBe(t(3)); // the first stamp stays
  expect(await s.dismissTriage("2026-10-16:NOPE", t(4))).toBeNull();
  put("triage.dismissed", await s.listTriage("2026-10-16"));
  expect((out["triage.dismissed"] as TriageItem[]).length).toBe(3); // a dismissed item still counts against the day
  expect((await s.listTriage("2026-10-17")).map((x) => x.coin)).toEqual(["SOL"]);
  expect(await s.listTriage("2026-10-18")).toEqual([]);

  // queue dismissals (025): upsert on (day, coin), a re-dismiss moves the stamp, listed per day in coin order
  expect(await s.listQueueDismissals("2026-10-16")).toEqual([]);
  expect(await s.dismissQueue("2026-10-16", "SOL", t(3))).toEqual({ day: "2026-10-16", coin: "SOL", dismissedAt: t(3) });
  await s.dismissQueue("2026-10-16", "xyz:TSLA", t(3));
  await s.dismissQueue("2026-10-17", "SOL", t(4));
  expect((await s.dismissQueue("2026-10-16", "SOL", t(5))).dismissedAt).toBe(t(5)); // re-dismiss after re-entry: time moves
  put("queue.dismissals", await s.listQueueDismissals("2026-10-16"));
  expect(out["queue.dismissals"]).toEqual([
    { day: "2026-10-16", coin: "SOL", dismissedAt: t(5) },
    { day: "2026-10-16", coin: "xyz:TSLA", dismissedAt: t(3) },
  ]);
  expect((await s.listQueueDismissals("2026-10-17")).map((d) => d.coin)).toEqual(["SOL"]);
  expect(await s.listQueueDismissals("2026-10-18")).toEqual([]);
  await expect(s.dismissQueue("16/10", "SOL", t(3))).rejects.toThrow();

  // moves runs and the triage pass (026): one row per window, an older run never replaces a newer one
  const ok = { state: "ok" as const, reason: null };
  const run = (window: MovesResponse["window"], h: number, coins: string[]): MovesResponse => ({
    state: "ok", reason: null, asOf: t(h), computedAt: t(h).replace(":00:00.000Z", ":03:00.000Z"), window, progress: null,
    universe: { coins: coins.length, dropped: [{ coin: "NOPE", reason: "not a listed main-dex perp" }] }, sectorsAsOf: null,
    factors: [{ id: "BTC", label: "BTC", pct: -1.25, n: 1 }], layers: { beta: ok, flow: { state: "unavailable", reason: "x" }, attention: ok, liq: ok, agents: ok },
    rows: coins.map((c) => moveRow(c, { sector: { id: "l1", label: "L1" } })),
  });
  expect(await s.latestMovesRun("24h")).toBeNull();
  await s.saveMovesRun(run("24h", 2, ["BTC", "SOL"]));
  await s.saveMovesRun(run("24h", 3, ["BTC", "ETH", "SOL"]));
  await s.saveMovesRun(run("24h", 1, ["BTC"])); // older than the stored run: ignored
  await s.saveMovesRun(run("4h", 3, ["BTC"]));
  await expect(s.saveMovesRun({ ...run("72h", 3, []), state: "pending", asOf: null })).rejects.toThrow();
  put("moves.24h", await s.latestMovesRun("24h"));
  put("moves.4h", await s.latestMovesRun("4h"));
  expect(out["moves.24h"]).toEqual(run("24h", 3, ["BTC", "ETH", "SOL"]));
  expect((out["moves.4h"] as MovesResponse).rows.map((r) => r.coin)).toEqual(["BTC"]);
  expect(await s.latestMovesRun("72h")).toBeNull();

  expect(await s.loadTriageScan()).toBeNull();
  await s.saveTriageScan({ day: "2026-10-16", at: t(2), state: "pending", reason: "first run", watched: 0, overBudget: 0 });
  await s.saveTriageScan({ day: "2026-10-16", at: t(3), state: "ok", reason: null, watched: 31, overBudget: 2 });
  put("triage.scan", await s.loadTriageScan());
  expect(out["triage.scan"]).toEqual({ day: "2026-10-16", at: t(3), state: "ok", reason: null, watched: 31, overBudget: 2 });
  return out;
}

describe("PlatformStore parity", () => {
  let mem: Record<string, unknown>;
  let pg: Record<string, unknown>;
  beforeAll(async () => {
    mem = await scenario(new MemoryPlatformStore());
    const db = pgliteDb(newPglite());
    await migrate(db, () => {});
    pg = await scenario(new PgPlatformStore(db));
  });

  test("memory and Postgres agree call for call", () => {
    expect(Object.keys(pg)).toEqual(Object.keys(mem));
    for (const k of Object.keys(mem)) expect({ [k]: pg[k] }).toEqual({ [k]: mem[k] });
  });

  test("ledger ids increase in insertion order", () => {
    const ids = (mem["ledger.o1"] as { id: number }[]).map((e) => e.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });
});

describe("pure store rules", () => {
  test("diffPositions: open, close, and only > 1% moves", () => {
    const prev = [{ ...btc(1, 50000), address: A1, updatedAt: t(0) }];
    expect(diffPositions(A1, t(1), prev, [btc(1.009, 50000)])).toEqual([]);
    expect(diffPositions(A1, t(1), prev, [btc(1.011, 50000)]).map((c) => c.kind)).toEqual(["change"]);
    expect(diffPositions(A1, t(1), prev, [btc(-1, 50000)]).map((c) => c.kind)).toEqual(["change"]);
    expect(diffPositions(A1, t(1), prev, [btc(1, null)]).map((c) => c.kind)).toEqual(["change"]);
    expect(diffPositions(A1, t(1), [], [btc(1, null)]).map((c) => c.kind)).toEqual(["open"]);
  });

  test("pollSummary: positions without a liquidation price do not set the distance", () => {
    expect(pollSummary([])).toEqual({ notionalUsd: 0, positionCount: 0, minLiqDistance: null });
    expect(pollSummary([btc(1, null)])).toEqual({ notionalUsd: 62000, positionCount: 1, minLiqDistance: null });
    expect(pollSummary([btc(-1, 68200)]).minLiqDistance).toBeCloseTo(0.1, 10);
  });
});
