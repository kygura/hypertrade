import { beforeAll, describe, expect, test } from "bun:test";
import type { LedgerPayload } from "../../shared/platform.js";
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
  expect(await s.outcomeRows({})).toEqual([{ opportunityId: o1, setupKind: "breakout", regime: "new_longs", liquidityTier: 1, horizon: "1h", createdAtMs: expect.any(Number), grossReturn: 0.01, netReturn: 0.0091, hasCosts: false }]);
  expect(await s.outcomeRows({ setupKind: "breakout", regime: "new_longs", tier: 1 })).toHaveLength(1);
  expect(await s.outcomeRows({ tier: 2 })).toEqual([]);
  expect(await s.outcomeRows({ regime: "range" })).toEqual([]);

  // retention: BTC t0 + ETH t0 liqmaps, BTC t0 scan; changes are all at t2+. The ledger is untouched.
  expect(await s.pruneHistory(t(1))).toBe(3);
  expect(await s.pruneHistory(t(3))).toBe(1 + 2 + 2); // BTC t1 liqmap, two t1 scans, two t2 opens
  expect((await s.ledgerFor(o1)).length).toBe(6);
  put("changes.after", await s.positionChanges(A1));
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
