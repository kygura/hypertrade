import { beforeEach, describe, expect, test } from "bun:test";
import { Bus } from "./bus.js";
import { clean, createScanner, type Info } from "./scanner.js";
import { MemoryPlatformStore } from "./store-memory.js";
import type { RingPoint } from "./features.js";

const MIN = 60_000;
const NOW = Date.UTC(2026, 9, 15, 12);
const N = 24 * 60;

/** 24 h of 1-min points ending at NOW: quiet zig-zag, then (pump) a 15-min +3% run with OI and volume building. */
function ring(pump: boolean): RingPoint[] {
  let mark = 100;
  return Array.from({ length: N }, (_, i) => {
    mark *= Math.exp(i % 2 ? -0.0005 : 0.0005 + (i % 7 === 0 ? 0.0002 : 0));
    const p = { ts: NOW - (N - 1 - i) * MIN, mark, oiUsd: 1e8 + (i % 5) * 1e5, funding: 1e-5 + (i % 3) * 1e-6, dayNtlVlm: 5e8 + (i % 11) * 1e6 };
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
function setup() {
  const store = new MemoryPlatformStore();
  const pumped = ring(true);
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
  beforeEach(async () => {
    s = setup();
    await s.store.insertScanSnapshots(
      ["PUMP", "A", "B", "C", "D", "E"].flatMap((coin) => (coin === "PUMP" ? s.pumped : ring(false)).map((p) => ({ coin, ts: new Date(p.ts).toISOString(), inputs: { mark: p.mark, oiUsd: p.oiUsd, funding: p.funding, dayNtlVlm: p.dayNtlVlm } }))),
    );
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
});
