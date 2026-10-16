import { describe, expect, test } from "bun:test";
import { createOutcomesLoop, skipped } from "./outcomesLoop.js";
import { MemoryPlatformStore } from "./store-memory.js";

const HOUR = 3_600_000;

async function seed() {
  const store = new MemoryPlatformStore();
  const { opportunity: o } = await store.upsertOpportunity(
    { coin: "BTC", direction: "long", setupKind: "k", tradeType: "directional", score: 2, scoreVersion: "v", tags: [], liquidityTier: 1, regime: "range", invalidation: "x", entryPx: 100, stopPx: 98, targetPx: 104, invalidationPx: 98 },
    { features: { features: {}, inputs: {} }, market: {}, score: 2, scoreVersion: "v" },
  );
  await store.setOpportunityCosts(o.id, { feeBps: 5, slippageBps: 3, fundingBps: 2, absorbableUsd: 1e4, grossEdgeBps: 400, netEdgeBps: 385, edgeBasis: "unvalidated" });
  return { store, o, created: Date.parse(o.createdAt) };
}

describe("outcomes loop", () => {
  test("appends one net-of-costs outcome per horizon, once (funding charged over the horizon)", async () => {
    const { store, o, created } = await seed();
    let t = created + 30 * 60_000;
    const loop = createOutcomesLoop({ store, mid: () => 101, scanMark: () => null, now: () => t });
    await loop.tick();
    expect(await store.outcomeRows({})).toHaveLength(0);
    t = created + HOUR;
    await loop.tick();
    await loop.tick();
    t = created + 4 * HOUR + 60_000;
    await loop.tick();
    await loop.tick();
    const rows = await store.outcomeRows({});
    expect(rows.map((r) => r.horizon)).toEqual(["1h", "4h"]);
    expect(rows[0]!.grossReturn).toBeCloseTo(0.01, 9);
    expect(rows[0]!.netReturn).toBeCloseTo(0.01 - 13.5 / 1e4, 9); // 2*5 fee + 3 slip + 2 bps funding × 1h/4h
    expect(rows[1]!.netReturn).toBeCloseTo(0.01 - 15 / 1e4, 9); // 4h: the full 2 bps funding
    expect(o.id).toBe(rows[0]!.opportunityId);
  });

  test("a restart does not re-mark (reads the ledger); falls back to the scan mark; prices a badly overdue horizon from the candle", async () => {
    const { store, created } = await seed();
    const t = created + HOUR + 60_000;
    await createOutcomesLoop({ store, mid: () => 101, scanMark: () => null, now: () => t }).tick();
    await createOutcomesLoop({ store, mid: () => null, scanMark: () => 102, now: () => t }).tick();
    expect(await store.outcomeRows({})).toHaveLength(1);
    const asked: Array<[number, number]> = [];
    const candles = async (_c: string, s: number, e: number) => (asked.push([s, e]), [{ t: created + 4 * HOUR - 60_000, T: created + 4 * HOUR, o: 1, h: 1, l: 1, c: 103, v: 1 }]);
    await createOutcomesLoop({ store, mid: () => 999, scanMark: () => 999, candles, now: () => created + 4 * HOUR + 3_600_000 }).tick();
    const rows = await store.outcomeRows({});
    expect(rows.map((r) => r.horizon)).toEqual(["1h", "4h"]); // 4h overdue by 1 h: priced at its own time, not now
    expect(rows[1]!.grossReturn).toBeCloseTo(0.03, 9);
    expect(asked).toHaveLength(1);
  });

  test("a horizon older than the candle range is counted in skipped(), once, and never marked", async () => {
    const { store, created } = await seed();
    const before = skipped();
    const t = created + 4 * HOUR + 83.2 * HOUR; // 4h is just inside the ~5000-candle range, 1h is outside it
    const candles = async () => [{ t: created + 4 * HOUR - 60_000, T: created + 4 * HOUR, o: 1, h: 1, l: 1, c: 103, v: 1 }];
    const loop = createOutcomesLoop({ store, mid: () => 101, scanMark: () => 101, candles, horizons: ["1h", "4h"], now: () => t });
    await loop.tick();
    await loop.tick();
    expect(skipped()).toBe(before + 1);
    expect((await store.outcomeRows({})).map((r) => r.horizon)).toEqual(["4h"]);
  });

  test("no price yet: nothing appended, retried next tick", async () => {
    const { store, created } = await seed();
    let px: number | null = null;
    const loop = createOutcomesLoop({ store, mid: () => px, scanMark: () => null, now: () => created + HOUR + 60_000 });
    await loop.tick();
    expect(await store.outcomeRows({})).toHaveLength(0);
    px = 99;
    await loop.tick();
    expect(await store.outcomeRows({})).toHaveLength(1);
  });

  test("an opened idea enters at its paper fill (fee and funding only, the fill carries slippage)", async () => {
    const { store, o, created } = await seed();
    await store.transitionOpportunity(o.id, "new", "calculated", "system");
    await store.transitionOpportunity(o.id, "calculated", "ready", "system");
    const seen = { score: 2, scoreVersion: "v", features: { features: {}, inputs: {} }, stopPx: 98, targetPx: 104, invalidationPx: 98, regime: "range", liquidityTier: 1 as const, costs: null };
    await store.transitionOpportunity(o.id, "ready", "approved", "operator", { decision: "approve", reason: null, operator: "op", seen });
    await store.transitionOpportunity(o.id, "approved", "open", "system", undefined, { ref: "11111111-1111-1111-1111-111111111111" });
    const asked: string[] = [];
    const loop = createOutcomesLoop({ store, mid: () => 102, scanMark: () => null, fillPx: async (id) => (asked.push(id), 100.5), now: () => created + HOUR + 1000 });
    await loop.tick();
    const out = (await store.ledgerFor(o.id)).find((e) => e.kind === "outcome");
    if (out?.kind !== "outcome") throw new Error("no outcome");
    expect(asked).toEqual(["11111111-1111-1111-1111-111111111111"]);
    expect(out.payload).toMatchObject({ entryBasis: "fill", entryPx: 100.5, horizonPx: 102 });
    expect(out.payload.netReturn).toBeCloseTo(102 / 100.5 - 1 - 10.5 / 1e4, 9); // 2*5 fee + 2 bps funding × 1h/4h
  });
});
