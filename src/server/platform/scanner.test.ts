import { beforeEach, describe, expect, test } from "bun:test";
import { Bus } from "./bus.js";
import { scoreOpportunity } from "./score.js";
import { clean, createScanner, type Info } from "./scanner.js";
import { MemoryPlatformStore } from "./store-memory.js";
import type { RingPoint } from "./features.js";

const MIN = 60_000;
const NOW = Date.UTC(2026, 9, 15, 12);
const N = 24 * 60;

/** 24 h of 1-min points ending at `end` (NOW by default): quiet zig-zag, then (pump) a 15-min +3% run with OI and volume building. */
function ring(pump: boolean, end = NOW): RingPoint[] {
  let mark = 100;
  return Array.from({ length: N }, (_, i) => {
    mark *= Math.exp(i % 2 ? -0.0005 : 0.0005 + (i % 7 === 0 ? 0.0002 : 0));
    const p = { ts: end - (N - 1 - i) * MIN, mark, oiUsd: 1e8 + (i % 5) * 1e5, funding: 1e-5 + (i % 3) * 1e-6, dayNtlVlm: 5e8 + (i % 11) * 1e6 };
    return pump && i >= N - 15 ? { ...p, mark: p.mark * (1 + 0.03 * ((i - (N - 16)) / 15)), oiUsd: p.oiUsd * 1.05, dayNtlVlm: p.dayNtlVlm * 1.2 } : p;
  });
}

const ctx = (mark: number, over: Record<string, string | null> = {}) => ({
  funding: "0.00001", openInterest: String(1e8 / mark), prevDayPx: String(mark), dayNtlVlm: "500000000", premium: "0", oraclePx: String(mark), markPx: String(mark), midPx: String(mark), impactPxs: null, dayBaseVlm: "1", ...over,
});
const book = (mark: number) => ({
  levels: [
    Array.from({ length: 20 }, (_, i) => ({ px: String(mark * (1 - 0.0002 * (i + 1))), sz: String(5e4 / mark), n: 1 })),
    Array.from({ length: 20 }, (_, i) => ({ px: String(mark * (1 + 0.0002 * (i + 1))), sz: String(5e4 / mark), n: 1 })),
  ],
});

/** PUMP has the pumped history; the rest are flat filler so the tiers have a universe. */
function setup(end = NOW) {
  const store = new MemoryPlatformStore();
  const pumped = ring(true, end);
  const last = pumped.at(-1)!;
  const coins = ["PUMP", "A", "B", "C", "D", "E"];
  const marks: Record<string, number> = { PUMP: last.mark * 1.002, A: 100, B: 100, C: 100, D: 100, E: 100 };
  const calls: string[] = [];
  let nan = false;
  const info = (async (body: { type: string; coin?: string }) => {
    calls.push(body.type);
    if (body.type === "l2Book") return book(marks[body.coin!]!);
    return [{ universe: coins.map((name) => ({ name, szDecimals: 3, maxLeverage: 20 })) }, coins.map((c) => ctx(marks[c]!, c === "PUMP" ? { funding: nan ? "oops" : "0.00001", openInterest: String(last.oiUsd / marks.PUMP!), dayNtlVlm: String(last.dayNtlVlm) } : {}))];
  }) as Info;
  return { store, info, calls, pumped, bus: new Bus(), setNaN: () => void (nan = true) };
}

describe("clean", () => {
  test("non-finite numbers and undefined become null, deeply", () => {
    expect(clean({ a: NaN, b: [Infinity, 1, -Infinity], c: { d: undefined, e: "x" } })).toEqual({ a: null, b: [null, 1, null], c: { d: null, e: "x" } });
  });
});

describe("cold-start seeding", () => {
  test("merges the extra source with scan_snapshots (own row wins per timestamp) and reports history minutes", async () => {
    const store = new MemoryPlatformStore();
    const row = (ts: number, mark: number) => ({ coin: "A", ts: new Date(ts).toISOString(), inputs: { mark, oiUsd: 1, funding: 0, dayNtlVlm: 1 } });
    await store.insertScanSnapshots([row(NOW - 30 * MIN, 111)]);
    const seedFrom = async () => [row(NOW - 90 * MIN, 1), row(NOW - 60 * MIN, 2), row(NOW - 30 * MIN, 999), { ...row(NOW, 3), inputs: { mark: null } }];
    const info = (async () => [{ universe: [{ name: "A", szDecimals: 3, maxLeverage: 20 }] }, [ctx(100)]]) as unknown as Info;
    const sc = createScanner({ store, info, now: () => NOW, seedFrom });
    expect(sc.historyMin()).toBeNull();
    await sc.tick();
    expect(sc.historyMin()).toBe(90);
    expect((await store.scanSnapshotsSince(new Date(NOW - 2 * 60 * MIN).toISOString())).length).toBe(2); // own + the tick's persist
  });
  test("a failing extra source does not stop the scan", async () => {
    const store = new MemoryPlatformStore();
    const info = (async () => [{ universe: [{ name: "A", szDecimals: 3, maxLeverage: 20 }] }, [ctx(100)]]) as unknown as Info;
    const sc = createScanner({ store, info, now: () => NOW, seedFrom: async () => Promise.reject(new Error("no table")) });
    await sc.tick();
    expect(sc.lastScanAt()).not.toBeNull();
  });
});

describe("scanner tick", () => {
  let s: ReturnType<typeof setup>;
  const seeded = async (end = NOW) => {
    const x = setup(end);
    await x.store.insertScanSnapshots(
      ["PUMP", "A", "B", "C", "D", "E"].flatMap((coin) => (coin === "PUMP" ? x.pumped : ring(false, end)).map((p) => ({ coin, ts: new Date(p.ts).toISOString(), inputs: { mark: p.mark, oiUsd: p.oiUsd, funding: p.funding, dayNtlVlm: p.dayNtlVlm } }))),
    );
    return x;
  };
  beforeEach(async () => {
    s = await seeded();
  });

  test("macro tag: the day before CPI is tagged; the score matches a day with no release", async () => {
    const top = async (end: number) => {
      const x = await seeded(end);
      await createScanner({ store: x.store, info: x.info, now: () => end + MIN, bus: x.bus }).tick();
      return (await x.store.listOpportunities({ limit: 1 }))[0]!;
    };
    const eve = await top(Date.UTC(2026, 9, 13, 12)); // CPI is 2026-10-14
    const quiet = await top(Date.UTC(2026, 9, 20, 12)); // no FOMC or CPI within a day
    expect(eve.tags).toContain("macro:CPI in 1 day");
    expect(quiet.tags.some((t) => t.startsWith("macro:"))).toBe(false);
    expect(eve.score).toBe(quiet.score);
  });

  test("one tick: ranked opportunity with costs, a created ledger entry, calculated -> ready, events", async () => {
    const seen: string[] = [];
    s.bus.subscribe("opportunity", (e) => seen.push(e.change));
    const scans: number[] = [];
    s.bus.subscribe("scan", (e) => scans.push(e.assets));
    const sc = createScanner({ store: s.store, info: s.info, now: () => NOW + MIN, bus: s.bus });
    await sc.tick();

    const opps = await s.store.listOpportunities({ limit: 10 });
    expect(opps.length).toBeGreaterThan(0);
    expect(opps.every((o) => o.coin === "PUMP")).toBe(true);
    expect(opps[0]!.score).toBeGreaterThan(0);
    for (let i = 1; i < opps.length; i++) expect(opps[i - 1]!.score).toBeGreaterThanOrEqual(opps[i]!.score);
    const o = opps[0]!;
    expect(o.costs).not.toBeNull();
    expect(o.edgeBasis).toBe("unvalidated");
    expect(o.grossEdgeBps).toBeCloseTo((Math.abs(o.targetPx! - o.entryPx!) / o.entryPx!) * 1e4, 6);
    expect(o.netEdgeBps).toBeCloseTo(o.grossEdgeBps! - 2 * o.costs!.feeBps - o.costs!.slippageBps - o.costs!.fundingBps, 6);
    expect(o.status).toBe("ready");
    const kinds = (await s.store.ledgerFor(o.id)).map((e) => e.kind);
    expect(kinds).toEqual(["created", "costs", "status", "status"]);
    expect(seen).toContain("created");
    expect(seen).toContain("status");
    expect(scans).toEqual([6]);
    expect(sc.lastScanAt()?.getTime()).toBe(NOW + MIN);
    expect(s.calls.filter((c) => c === "l2Book")).toHaveLength(1);
  });

  test("a second tick dedupes: same ids, no new created entries", async () => {
    let t = NOW + MIN;
    const sc = createScanner({ store: s.store, info: s.info, now: () => t, bus: s.bus });
    await sc.tick();
    const first = await s.store.listOpportunities({ limit: 10 });
    t += MIN;
    await sc.tick();
    const second = await s.store.listOpportunities({ limit: 10 });
    expect(first.length).toBeGreaterThan(0);
    for (const o of first) expect(second.find((x) => x.dedupeKey === o.dedupeKey)?.id).toBe(o.id);
    expect(new Set(second.map((o) => o.dedupeKey)).size).toBe(second.length);
    expect(s.store.ledger.filter((e) => e.kind === "created")).toHaveLength(second.length);
    for (const o of first) expect(s.store.ledger.filter((e) => e.kind === "costs" && e.opportunityId === o.id)).toHaveLength(1);
  });

  test("a NaN input (bad funding) is stored as null and never throws", async () => {
    s.setNaN();
    const sc = createScanner({ store: s.store, info: s.info, now: () => NOW + MIN, bus: s.bus });
    await sc.tick();
    const created = s.store.ledger.find((e) => e.kind === "created");
    if (created?.kind !== "created") throw new Error("expected a created entry");
    expect(created.payload.features.inputs.funding).toBeNull();
    expect(created.payload.market.funding).toBeNull();
  });

  test("a ready idea expires after the TTL from statusChangedAt", async () => {
    let t = NOW + MIN;
    const sc = createScanner({ store: s.store, info: s.info, now: () => t, bus: s.bus, readyTtlMin: 60 });
    await sc.tick();
    const [o] = await s.store.listOpportunities({ statuses: ["ready"], limit: 1 });
    expect(o).toBeDefined();
    const row = s.store.opportunities.get(o!.id)!;
    row.statusChangedAt = new Date(t - 61 * MIN).toISOString();
    t += MIN;
    await sc.tick();
    expect((await s.store.getOpportunity(o!.id))!.status).toBe("expired");
  });

  test("determinism: the score recomputed from the created entry's stored features equals the stored score", async () => {
    const sc = createScanner({ store: s.store, info: s.info, now: () => NOW + MIN, bus: s.bus });
    await sc.tick();
    const created = s.store.ledger.filter((e) => e.kind === "created");
    expect(created.length).toBeGreaterThan(0);
    for (const e of created) if (e.kind === "created") expect(scoreOpportunity(e.payload.features)).toBe(e.payload.score);
  });

  test("cooldown: a rejected key is not recreated until PLATFORM_COOLDOWN_MIN has passed", async () => {
    let t = NOW + MIN;
    const sc = createScanner({ store: s.store, info: s.info, now: () => t, bus: s.bus, cooldownMin: 10 });
    await sc.tick();
    const [o] = await s.store.listOpportunities({ statuses: ["ready"], limit: 1 });
    const seen = { score: o!.score, scoreVersion: "v", features: { features: {}, inputs: {} }, stopPx: 1, targetPx: 2, invalidationPx: 1, regime: "range", liquidityTier: 1 as const, costs: null };
    await s.store.transitionOpportunity(o!.id, "ready", "rejected", "operator", { decision: "reject", reason: "no", operator: "op", seen });
    const pump = async () => (await s.store.listOpportunities({ limit: 50 })).filter((x) => x.coin === "PUMP").length;
    const before = await pump();
    s.store.opportunities.get(o!.id)!.statusChangedAt = new Date(t - 5 * MIN).toISOString();
    t += MIN;
    await sc.tick();
    expect(await pump()).toBe(before); // 6 min after the reject: still cooling down
    s.store.opportunities.get(o!.id)!.statusChangedAt = new Date(t - 11 * MIN).toISOString();
    t += MIN;
    await sc.tick();
    expect(await pump()).toBe(before + 1);
  });

  test("ledger edge basis: net is the 4 h mean and gross = net + costs, so net = gross − costs holds", async () => {
    const probe = await seeded();
    await createScanner({ store: probe.store, info: probe.info, now: () => NOW + MIN, bus: probe.bus }).tick();
    const kind = (await probe.store.listOpportunities({ limit: 1 }))[0]!.setupKind;
    const { opportunity: old } = await s.store.upsertOpportunity(
      { coin: "OLD", direction: "long", setupKind: kind, tradeType: "directional", score: 1, scoreVersion: "v", tags: [], liquidityTier: 1, regime: "range", invalidation: "x", entryPx: 100, stopPx: 98, targetPx: 104, invalidationPx: 98 },
      { features: { features: {}, inputs: {} }, market: {}, score: 1, scoreVersion: "v" },
    );
    await s.store.setOpportunityCosts(old.id, { feeBps: 5, slippageBps: 3, fundingBps: 2, absorbableUsd: 1e4, grossEdgeBps: 400, netEdgeBps: 385, edgeBasis: "unvalidated" });
    await s.store.appendLedger({ opportunityId: old.id, kind: "outcome", payload: { horizon: "4h", entryBasis: "mark", entryPx: 100, horizonPx: 102, grossReturn: 0.02, netReturn: 0.0185 } });
    await createScanner({ store: s.store, info: s.info, now: () => NOW + MIN, bus: s.bus, edgeMinN: 1 }).tick();
    const o = (await s.store.listOpportunities({ limit: 50 })).find((x) => x.coin === "PUMP" && x.setupKind === kind)!;
    expect(o.edgeBasis).toBe("ledger");
    expect(o.netEdgeBps).toBeCloseTo(185, 6);
    expect(o.netEdgeBps).toBeCloseTo(o.grossEdgeBps! - 2 * o.costs!.feeBps - o.costs!.slippageBps - o.costs!.fundingBps, 6);
  });

  test("scan universe: setups run only on the filtered coins (PLATFORM_SCAN_UNIVERSE)", async () => {
    await createScanner({ store: s.store, info: s.info, now: () => NOW + MIN, bus: s.bus, filter: { mine: ["A"] } }).tick();
    expect(await s.store.listOpportunities({ limit: 50 })).toEqual([]);
    await createScanner({ store: s.store, info: s.info, now: () => NOW + MIN, bus: s.bus, filter: { mine: ["PUMP"] } }).tick();
    expect((await s.store.listOpportunities({ limit: 50 })).map((o) => o.coin)).toContain("PUMP");
  });

  test("latestMark is null once older than 2 scan intervals", async () => {
    let t = NOW + MIN;
    const sc = createScanner({ store: s.store, info: s.info, now: () => t, bus: s.bus });
    await sc.tick();
    expect(sc.latestMark("PUMP")).not.toBeNull();
    t += 2 * MIN + 1;
    expect(sc.latestMark("PUMP")).toBeNull();
  });
});
