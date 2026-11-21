import { describe, expect, test } from "bun:test";
import { EXTREMES_SCORE_VERSION } from "../../shared/extremes.js";
import { DEFAULT_TAKER_FEE_BPS } from "./costs.js";
import { createOutcomesLoop, skipped } from "./outcomesLoop.js";
import { groupStats, setupLedgerStats } from "./stats.js";
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
  test("an extremes take is marked like any idea (fee-only: it has no costs) and stays out of the ledger stats, scanner or its own", async () => {
    const { store, created } = await seed();
    const { opportunity: x } = await store.upsertOpportunity(
      { coin: "BTC", direction: "short", setupKind: "oi_flush", tradeType: "directional", score: 4.2, scoreVersion: EXTREMES_SCORE_VERSION, tags: ["extreme", "oi_flush"], liquidityTier: 1, regime: "unknown", invalidation: "Above 110 (kill). x", entryPx: 100, stopPx: 110, targetPx: null, invalidationPx: 110 },
      { features: { features: {}, inputs: {} }, market: {}, score: 4.2, scoreVersion: EXTREMES_SCORE_VERSION },
    );
    await createOutcomesLoop({ store, mid: () => 99, scanMark: () => null, now: () => created + HOUR + 60_000 }).tick();
    const rows = await store.outcomeRows({});
    const take = rows.find((r) => r.opportunityId === x.id)!;
    expect(take).toMatchObject({ setupKind: "oi_flush", scoreVersion: EXTREMES_SCORE_VERSION, horizon: "1h", hasCosts: false });
    expect(take.netReturn).toBeCloseTo(0.01 - 2 * DEFAULT_TAKER_FEE_BPS / 1e4, 9);
    // groupStats skips rows without a cost breakdown (P0.13): the take is in no group; the scanner row's group is its own.
    expect(groupStats(rows).map((g) => g.setupKind)).toEqual(["k"]);
    expect(setupLedgerStats("oi_flush", rows)).toBeNull();
  });

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

  test("a horizon older than the candle range is written as ungraded (and counted in skipped()), once, and never priced", async () => {
    const { store, created } = await seed();
    const before = skipped();
    const t = created + 4 * HOUR + 83.2 * HOUR; // 4h is just inside the ~5000-candle range, 1h is outside it
    const candles = async () => [{ t: created + 4 * HOUR - 60_000, T: created + 4 * HOUR, o: 1, h: 1, l: 1, c: 103, v: 1 }];
    const loop = createOutcomesLoop({ store, mid: () => 101, scanMark: () => 101, candles, horizons: ["1h", "4h"], now: () => t });
    await loop.tick();
    await loop.tick();
    expect(skipped()).toBe(before + 1);
    // Not dropped: the 1h horizon is in the ledger as ungraded, with its reason, and the stats count it.
    const rows = await store.outcomeRows({});
    expect(rows.map((r) => [r.horizon, r.ungraded])).toEqual([["1h", "past_candle_range"], ["4h", undefined]]);
    expect(groupStats(rows).map((g) => [g.horizon, g.n, g.ungraded, g.meanNet === null])).toEqual([["1h", 0, 1, true], ["4h", 1, 0, false]]);
    // A restart reads it back: not counted or written twice.
    await createOutcomesLoop({ store, mid: () => 101, scanMark: () => 101, candles, horizons: ["1h", "4h"], now: () => t }).tick();
    expect(skipped()).toBe(before + 1);
    expect(await store.outcomeRows({})).toHaveLength(2);
  });

  test("an idea whose every horizon passed the candle range while the process was down: all its horizons become ungraded, once", async () => {
    const { store, o, created } = await seed();
    const before = skipped();
    await createOutcomesLoop({ store, mid: () => 101, scanMark: () => null, horizons: ["1h", "4h"], now: () => created + HOUR + 1000 }).tick(); // 1h marked live
    const loop = createOutcomesLoop({ store, mid: () => 101, scanMark: () => 101, candles: async () => [], horizons: ["1h", "4h"], now: () => created + 10 * 24 * HOUR });
    await loop.tick();
    await loop.tick();
    expect((await store.outcomeRows({})).map((r) => [r.opportunityId, r.horizon, r.ungraded])).toEqual([[o.id, "1h", undefined], [o.id, "4h", "past_candle_range"]]);
    expect(skipped() - before).toBe(1);
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
    if ("ungraded" in out.payload) throw new Error("ungraded");
    expect(out.payload).toMatchObject({ entryBasis: "fill", entryPx: 100.5, horizonPx: 102 });
    expect(out.payload.netReturn).toBeCloseTo(102 / 100.5 - 1 - 10.5 / 1e4, 9); // 2*5 fee + 2 bps funding × 1h/4h
  });

  test("late-horizon candle fetches are capped per tick", async () => {
    const { store, created } = await seed();
    const horizons = Array.from({ length: 12 }, (_, i) => `${i + 1}h`);
    let asked = 0;
    const candles = async () => (asked++, [{ t: created, T: created + 60_000, o: 1, h: 1, l: 1, c: 103, v: 1 }]);
    const loop = createOutcomesLoop({ store, mid: () => 1, scanMark: () => 1, candles, horizons, now: () => created + 20 * HOUR });
    await loop.tick();
    expect(asked).toBe(10);
    expect(await store.outcomeRows({})).toHaveLength(10);
    await loop.tick();
    expect(asked).toBe(13); // 11h, then 12h (the longest) with its trade-path read
    expect(await store.outcomeRows({})).toHaveLength(12);
  });

  describe("stop/target trade (longest horizon)", () => {
    const MIN = 60_000;
    /** 1-min candles from the entry over 4 h, flat at 100 except the bars given by minute. */
    const path = (created: number, bars: Record<number, { h?: number; l?: number; o?: number }>, minutes = 240) =>
      Array.from({ length: minutes }, (_, i) => ({ t: created + i * MIN, T: created + (i + 1) * MIN - 1, o: 100, h: 100, l: 100, c: 100, v: 1, ...bars[i] }));
    const run = async (bars: Parameters<typeof path>[1], horizonPx: number, minutes?: number) => {
      const { store, created } = await seed(); // long, entry 100, stop 98, target 104; fee 5, slip 3, funding 2 bps per 4 h
      const candles = async () => path(created, bars, minutes);
      await createOutcomesLoop({ store, mid: () => horizonPx, scanMark: () => null, candles, horizons: ["1h", "4h"], now: () => created + 4 * HOUR + 1000 }).tick();
      const rows = await store.outcomeRows({});
      return { created, h1: rows.find((r) => r.horizon === "1h")!, h4: rows.find((r) => r.horizon === "4h")! };
    };

    test("the target is touched before a slide: the trade is +target while the fixed horizon is a loss", async () => {
      const { created, h1, h4 } = await run({ 30: { h: 104.5 } }, 97);
      expect(h4.grossReturn).toBeCloseTo(-0.03, 9); // hold to 4 h, as before
      expect(h1.trade).toBeUndefined(); // only the longest horizon carries it
      expect(h4.trade).toMatchObject({ exit: "target", exitPx: 104, stopPx: 98, targetPx: 104, ambiguous: false, exitAt: new Date(created + 31 * MIN - 1).toISOString() });
      const net = 0.04 - (2 * 5 + 3 + (2 * (31 * MIN - 1)) / (4 * HOUR)) / 1e4; // funding over the 31 min held
      expect(h4.trade!.netReturn).toBeCloseTo(net, 9);
      expect(h4.trade!.r).toBeCloseTo(net / 0.02, 9);
    });

    test("stop and target inside one bar: the stop, flagged ambiguous; a gap through the stop fills at the open", async () => {
      const both = (await run({ 10: { h: 105, l: 97 } }, 104)).h4;
      expect(both.trade).toMatchObject({ exit: "stop", exitPx: 98, ambiguous: true });
      expect(both.trade!.r).toBeLessThan(-1); // a full stop plus costs
      expect(both.grossReturn).toBeCloseTo(0.04, 9);
      expect((await run({ 10: { o: 97, h: 97, l: 96 } }, 100)).h4.trade).toMatchObject({ exit: "stop", exitPx: 97, ambiguous: false });
    });

    test("neither touched: out at the longest horizon's price, the same net as the fixed outcome", async () => {
      const { h4 } = await run({}, 101);
      expect(h4.trade).toMatchObject({ exit: "horizon", exitPx: 101 });
      expect(h4.trade!.netReturn).toBeCloseTo(h4.netReturn, 9);
    });

    test("candles that do not cover the path: the fixed outcome is written without a trade", async () => {
      const { h4 } = await run({ 10: { l: 97 } }, 101, 120); // the last 2 h are missing
      expect(h4.netReturn).toBeGreaterThan(0);
      expect(h4.trade).toBeUndefined();
    });
  });

  test("late rows without an entry price do not spend the late-fetch budget", async () => {
    const store = new MemoryPlatformStore();
    const mk = (coin: string, entryPx: number | null, score = 2) =>
      store.upsertOpportunity(
        { coin, direction: "long", setupKind: "k", tradeType: "directional", score, scoreVersion: "v", tags: [], liquidityTier: 1, regime: "range", invalidation: "x", entryPx: entryPx as never, stopPx: 98, targetPx: 104, invalidationPx: 98 },
        { features: { features: {}, inputs: {} }, market: {}, score: 2, scoreVersion: "v" },
      );
    for (let i = 0; i < 12; i++) await mk(`N${i}`, null, 5); // listed first (score order)
    const { opportunity: o } = await mk("ETH", 100);
    const created = Date.parse(o.createdAt);
    const candles = async () => [{ t: created, T: created + 60_000, o: 1, h: 1, l: 1, c: 103, v: 1 }];
    const loop = createOutcomesLoop({ store, mid: () => 1, scanMark: () => 1, candles, horizons: ["1h"], now: () => created + 20 * HOUR });
    await loop.tick();
    expect(await store.outcomeRows({})).toHaveLength(1);
  });

  test("a horizon with 3 empty candle answers is written as ungraded and not retried", async () => {
    const { store, created } = await seed();
    let asked = 0;
    const before = skipped();
    const loop = createOutcomesLoop({ store, mid: () => 1, scanMark: () => 1, candles: async () => (asked++, []), horizons: ["1h"], now: () => created + 2 * HOUR });
    const quiet = console.error;
    console.error = () => {};
    try {
      for (let i = 0; i < 5; i++) await loop.tick();
    } finally {
      console.error = quiet;
    }
    expect(asked).toBe(3);
    expect(skipped() - before).toBe(1);
    expect((await store.outcomeRows({})).map((r) => [r.horizon, r.ungraded, Number.isNaN(r.netReturn)])).toEqual([["1h", "no_candles", true]]);
  });
});
