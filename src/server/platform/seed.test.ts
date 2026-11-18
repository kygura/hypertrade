import { describe, expect, test } from "bun:test";
import type { Candle } from "../../shared/types.js";
import { FEATURE_MIN_TICKS_24H } from "./features.js";
import { candleStream, GRID_MS, snapshotDensity, snapshotStreams } from "./replaySource.js";
import { parseIntradayOi, runSnapshotSeed, SEED_DAYS, seedPlan, type SnapshotSeedDeps } from "./seed.js";
import { MemoryPlatformStore } from "./store-memory.js";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 18, 12, 7); // mid-candle: the 12:00 bar is still open
const END = Math.floor(NOW / GRID_MS) * GRID_MS;
const iso = (t: number) => new Date(t).toISOString();

/** 15-min candles ending at END, price 100, 10 coins a bar. */
const candles = (days: number): Candle[] =>
  Array.from({ length: days * 96 }, (_, i) => ({ t: END - (i + 1) * GRID_MS, o: 100, h: 100, l: 100, c: 100, v: 10 }) as Candle).reverse();
const funding = (days: number) => Array.from({ length: days * 24 }, (_, i) => ({ t: END - (i + 1) * 3_600_000, rate: 0.0000125, premium: 0 })).reverse();
/** 5000 coins of OI on every bar close of the last `days`, plus the still-open bar. */
const oi = (days: number) => new Map(Array.from({ length: days * 96 + 1 }, (_, i) => [END + GRID_MS - i * GRID_MS, 5000] as const));

const deps = (store: MemoryPlatformStore, over: Partial<SnapshotSeedDeps> = {}): SnapshotSeedDeps => ({
  coins: async () => ["SOL"],
  candles: async (_c, s, e) => candles(SEED_DAYS + 1).filter((c) => c.t >= s && c.t <= e),
  funding: async () => funding(SEED_DAYS + 2),
  oi: async () => oi(SEED_DAYS),
  store, now: () => NOW, dryRun: false, ...over,
});

describe("snapshot seed", () => {
  test("parseIntradayOi keys a bar by its close", () => {
    const m = parseIntradayOi([{ symbol: "SOL.H", history: [{ t: END / 1000 - 900, c: 5000 }] }]);
    expect([...m]).toEqual([[END, 5000]]);
    expect(parseIntradayOi([]).size).toBe(0);
  });

  test("seedPlan fills empty slots only; oiUsd is coins times the close, the live row's unit", () => {
    const stream = candleStream(candles(3), funding(4));
    const live = { coin: "SOL", ts: iso(END - 7 * 60_000), inputs: { mark: 100.2, oiUsd: 501_000, funding: 0.00001, dayNtlVlm: 9e4 } };
    const plan = seedPlan("SOL", stream, oi(3), [live]);
    // Slots from one day after the first candle's open have a full 24 h of volume behind them (2 days + 1); the newest holds the stored row.
    expect(plan.rows.length).toBe(2 * 96);
    expect(plan.rows.some((r) => r.ts === iso(END))).toBe(false);
    expect(plan.rows.at(-1)).toEqual({ coin: "SOL", ts: iso(END - GRID_MS), inputs: { mark: 100, oiUsd: 500_000, funding: 0.0000125, dayNtlVlm: 96_000, seeded: "coinalyze" } });
    expect(plan).toMatchObject({ overlap: 1, consistent: true });
    expect(plan.oiRatio).toBeCloseTo(500_000 / 501_000, 6);
  });

  test("a coin whose seeded OI disagrees with its stored rows is not written (a unit or symbol mismatch)", async () => {
    const store = new MemoryPlatformStore();
    // Stored OI in USD is 100x the seed: as if the seed were in a different unit.
    await store.insertScanSnapshots(Array.from({ length: 10 }, (_, i) => ({ coin: "SOL", ts: iso(END - i * GRID_MS - 60_000), inputs: { mark: 100, oiUsd: 5e7, funding: 0, dayNtlVlm: 1e5 } })));
    const [r] = await runSnapshotSeed(deps(store));
    expect(r).toMatchObject({ written: 0, overlap: 10, skipped: "seeded OI is 0.01x the stored OI over 10 shared slots" });
    expect((await store.scanSnapshotsSince(iso(0))).length).toBe(10);
  });

  test("a run makes scan_snapshots dense enough for the features, is idempotent, and a dry run writes nothing", async () => {
    const store = new MemoryPlatformStore();
    const [dry] = await runSnapshotSeed(deps(store, { dryRun: true }));
    expect(dry).toMatchObject({ planned: SEED_DAYS * 96, written: 0, skipped: null });
    expect((await store.scanSnapshotsSince(iso(0))).length).toBe(0);

    const [first] = await runSnapshotSeed(deps(store));
    expect(first!.written).toBe(SEED_DAYS * 96);
    const rows = await store.scanSnapshotsSince(iso(0));
    expect(snapshotDensity(rows, END)).toMatchObject({ medianTicks: FEATURE_MIN_TICKS_24H, dense: true });
    // The scanner's own parse reads every seeded row: OI is present on each.
    expect(snapshotStreams(rows).get("SOL")!.length).toBe(SEED_DAYS * 96);

    const [again] = await runSnapshotSeed(deps(store));
    expect(again).toMatchObject({ planned: 0, written: 0, overlap: SEED_DAYS * 96, oiRatio: 1 });
  });

  test("one coin failing or unlisted does not stop the others", async () => {
    const store = new MemoryPlatformStore();
    const out = await runSnapshotSeed(deps(store, {
      coins: async () => ["AAA", "BBB", "SOL"],
      oi: async (coin) => { if (coin === "AAA") throw new Error("coinalyze open-interest-history: HTTP 500"); return coin === "BBB" ? null : oi(SEED_DAYS); },
    }));
    expect(out.map((r) => [r.coin, r.skipped, r.written > 0])).toEqual([
      ["AAA", "coinalyze open-interest-history: HTTP 500", false],
      ["BBB", "no Hyperliquid perp on Coinalyze", false],
      ["SOL", null, true],
    ]);
  });
});
