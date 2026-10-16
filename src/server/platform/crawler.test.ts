import { describe, expect, test } from "bun:test";
import { createCrawler, parseClearinghouse } from "./crawler.js";
import type { Info } from "./scanner.js";
import { MemoryPlatformStore } from "./store-memory.js";

const addr = (i: number) => "0x" + i.toString(16).padStart(40, "0");
const pos = (coin: string, szi: string, over: Record<string, unknown> = {}) => ({ type: "oneWay", position: { coin, szi, entryPx: "100", positionValue: "5000", liquidationPx: "80", leverage: { type: "cross", value: 5 }, ...over } });

describe("parseClearinghouse", () => {
  test("skips and counts bad rows; nulls an absent liquidationPx", () => {
    const r = parseClearinghouse({ assetPositions: [pos("BTC", "1"), pos("ETH", "0"), pos("SOL", "-2", { liquidationPx: null }), { nope: 1 }, pos("BTC", "3"), pos("DOGE", "1", { entryPx: "x" })] })!;
    expect(r.positions.map((p) => p.coin)).toEqual(["BTC", "SOL"]);
    expect(r.positions[1]!.liquidationPx).toBeNull();
    expect(r.positions[0]).toMatchObject({ szi: 1, liquidationPx: 80, leverage: 5 });
    expect(r.bad).toBe(4);
  });
  test("a wrong envelope is null", () => {
    expect(parseClearinghouse(null)).toBeNull();
    expect(parseClearinghouse({ assetPositions: "x" })).toBeNull();
  });
});

describe("crawler", () => {
  async function run(o: { weightPerMin: number; guard?: number; ticks: number; response?: unknown }) {
    const store = new MemoryPlatformStore();
    await store.recordAddresses(Array.from({ length: 3000 }, (_, i) => ({ address: addr(i + 1), seenAt: "2026-10-15T00:00:00Z" })));
    let t = Date.UTC(2026, 9, 15, 12);
    const calls: number[] = [];
    const info = (async () => (calls.push(t), o.response ?? { assetPositions: [pos("BTC", "1")] })) as unknown as Info;
    const c = createCrawler({ store, info, now: () => t, weightPerMin: o.weightPerMin, guardWaitMs: () => o.guard ?? 0 });
    for (let i = 0; i < o.ticks; i++) {
      t += 5_000;
      await c.tick();
    }
    return { c, calls, store };
  }

  test("respects the weight budget: no 60 s window holds more than weightPerMin / 2 polls (plus one tick of burst)", async () => {
    const { calls, c } = await run({ weightPerMin: 800, ticks: 48 });
    expect(calls.length).toBeGreaterThan(300);
    for (const t of calls) expect(calls.filter((x) => x > t - 60_000 && x <= t).length).toBeLessThanOrEqual(400 + 34);
    expect(c.pollsPerMin()).toBeGreaterThan(0);
    expect(c.pollsPerMin()).toBeLessThanOrEqual(400 + 34);
  });

  test("a smaller budget polls less", async () => {
    const big = await run({ weightPerMin: 800, ticks: 24 });
    const small = await run({ weightPerMin: 80, ticks: 24 });
    expect(small.calls.length).toBeLessThan(big.calls.length / 5);
  });

  test("yields while the shared guard is full", async () => {
    const { calls } = await run({ weightPerMin: 800, guard: 1_000, ticks: 12 });
    expect(calls).toHaveLength(0);
  });

  test("polls are saved; a malformed response is counted and does not throw", async () => {
    const ok = await run({ weightPerMin: 800, ticks: 3 });
    expect([...ok.store.positions.values()].length).toBeGreaterThan(0);
    const bad = await run({ weightPerMin: 800, ticks: 3, response: { garbage: true } });
    expect(bad.c.bad).toBeGreaterThan(0);
    expect(bad.c.pollsPerMin()).toBe(0);
  });
});
