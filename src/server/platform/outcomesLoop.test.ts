import { describe, expect, test } from "bun:test";
import { createOutcomesLoop } from "./outcomesLoop.js";
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
  test("appends one net-of-costs outcome per horizon, once", async () => {
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
    expect(rows[0]!.netReturn).toBeCloseTo(0.01 - 15 / 1e4, 9);
    expect(o.id).toBe(rows[0]!.opportunityId);
  });

  test("a restart does not re-mark (reads the ledger); falls back to the scan mark; skips a badly overdue horizon", async () => {
    const { store, created } = await seed();
    const t = created + HOUR + 60_000;
    await createOutcomesLoop({ store, mid: () => 101, scanMark: () => null, now: () => t }).tick();
    await createOutcomesLoop({ store, mid: () => null, scanMark: () => 102, now: () => t }).tick();
    expect(await store.outcomeRows({})).toHaveLength(1);
    await createOutcomesLoop({ store, mid: () => null, scanMark: () => 102, now: () => created + 4 * HOUR + 3_600_000 }).tick();
    expect((await store.outcomeRows({})).map((r) => r.horizon)).toEqual(["1h"]); // 4h overdue by 1 h: skipped, not mispriced
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
});
