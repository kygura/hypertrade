import { describe, expect, test } from "bun:test";
import { SetupReplayResponseSchema } from "../../shared/research.js";
import type { Candle } from "../../shared/types.js";
import { FEATURE_MIN_TICKS_24H } from "./features.js";
import { fixtureTicks } from "./replay.fixture.js";
import { candleStream, createReplayService, formatReplay, GRID_MS, memoSeries, replayParams, runCandleReplay, runSnapshotReplay, snapshotDensity, snapshotStreams } from "./replaySource.js";
import { MemoryPlatformStore } from "./store-memory.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 9, 1);
const candle = (i: number, c: number, v = 10): Candle => ({ t: T0 + i * GRID_MS, T: T0 + (i + 1) * GRID_MS - 1, o: c, h: c, l: c, c, v });
const params = replayParams({});

describe("candleStream", () => {
  const cs = Array.from({ length: 200 }, (_, i) => candle(i, 100 + i));
  const fs = [{ t: T0 + HOUR, rate: 1e-5, premium: 0 }, { t: T0 + 2 * HOUR, rate: 2e-5, premium: 0 }];
  const pts = candleStream(cs, fs);

  test("one point per candle at its close; mark = close; no OI", () => {
    expect(pts).toHaveLength(200);
    expect(pts[0]).toMatchObject({ ts: T0 + GRID_MS, mark: 100 });
    expect(pts.every((p) => Number.isNaN(p.oiUsd))).toBe(true);
  });
  test("24 h volume: NaN until the stream has 24 h behind it, then the trailing sum of volume × close", () => {
    expect(Number.isNaN(pts[94]!.dayNtlVlm)).toBe(true);
    // point i (close T0 + (i+1)·15m) sums candles i−95..i
    for (const i of [95, 150, 199]) expect(pts[i]!.dayNtlVlm).toBeCloseTo(Array.from({ length: 96 }, (_, k) => 10 * (100 + i - k)).reduce((a, b) => a + b, 0), 6);
  });
  test("funding: the latest settlement at or before the point, never a later one", () => {
    expect(Number.isNaN(pts[2]!.funding)).toBe(true); // 45 min: no settlement yet
    expect(pts[3]!.funding).toBe(1e-5); // 60 min
    expect(pts[6]!.funding).toBe(1e-5); // 1 h 45
    expect(pts[7]!.funding).toBe(2e-5); // 2 h
  });
});

describe("snapshots", () => {
  const now = T0 + 3 * DAY;
  const rows = (everyMin: number) =>
    Array.from({ length: (3 * DAY) / (everyMin * MIN) }, (_, i) => ({ coin: "A", ts: new Date(now - i * everyMin * MIN).toISOString(), inputs: { mark: 100, oiUsd: 1e6, funding: 1e-5, dayNtlVlm: 1e8 } }));

  test("density: 6-hourly ticks are too sparse, 5-min ticks are dense", () => {
    expect(snapshotDensity(rows(360), now)).toEqual({ windows: 2, medianTicks: 4, dense: false }) // 66 h of rows: two whole 24 h windows;
    expect(snapshotDensity(rows(5), now)).toMatchObject({ windows: 2, medianTicks: 288, dense: true });
    expect(snapshotDensity([], now)).toEqual({ windows: 0, medianTicks: 0, dense: false });
    expect(FEATURE_MIN_TICKS_24H).toBe(96);
  });
  test("streams skip rows with a non-finite input, as the scanner's seed does", () => {
    const s = snapshotStreams([...rows(360).slice(0, 2), { coin: "A", ts: new Date(now - 7 * HOUR).toISOString(), inputs: { mark: 1, oiUsd: null, funding: 0, dayNtlVlm: 1 } }]);
    expect(s.get("A")).toHaveLength(2);
  });
  test("a sparse store answers unavailable with the numbers", async () => {
    const store = new MemoryPlatformStore();
    await store.insertScanSnapshots(rows(360));
    const r = SetupReplayResponseSchema.parse(await runSnapshotReplay({ store, now: () => now, sinceDays: 30, params }));
    expect(r.state).toBe("unavailable");
    expect(r.reason).toBe("too sparse: median 4 scanner ticks per 24 h over 2 day(s) of scan_snapshots; the features need 96 (one per 15 min)");
  });
  test("a dense store replays every setup (OI present)", async () => {
    const store = new MemoryPlatformStore();
    await store.insertScanSnapshots(fixtureTicks().map((t) => ({ coin: t.coin, ts: new Date(t.ts).toISOString(), inputs: { mark: t.mark, oiUsd: t.openInterest * t.mark, funding: t.funding, dayNtlVlm: t.dayNtlVlm } })));
    const last = Math.max(...fixtureTicks().map((t) => t.ts));
    const r = SetupReplayResponseSchema.parse(await runSnapshotReplay({ store, now: () => last, sinceDays: 30, params }));
    expect(r.state).toBe("ok");
    expect(r.setups.every((s) => s.evaluable)).toBe(true);
    expect(new Set(r.setups.filter((s) => s.entries > 0).map((s) => s.kind))).toEqual(new Set(["deleveraging_washout", "vol_expansion_breakout", "crowded_long"]));
  });
});

describe("runCandleReplay", () => {
  test("candles of the fixture: OI setups not evaluable, the breakout fires, universe is the top N, tiers ranked against the rest", async () => {
    const ticks = fixtureTicks();
    const end = Math.max(...ticks.map((t) => t.ts));
    const asked: string[] = [];
    const r = SetupReplayResponseSchema.parse(await runCandleReplay({
      universe: async () => [...new Set(ticks.map((t) => t.coin))].map((coin) => ({ coin, dayNtlVlm: ticks.find((t) => t.coin === coin)!.dayNtlVlm })),
      candles: async (coin) => {
        asked.push(coin);
        // A tick at ts is the close of the candle that opened 15 min earlier; the volume makes the trailing 24 h sum grow.
        return ticks.filter((t) => t.coin === coin).map((t, i) => ({ t: t.ts - GRID_MS, T: t.ts - 1, o: t.mark, h: t.mark, l: t.mark, c: t.mark, v: (1e6 * (1 + (i % 5) * 0.01) * (i >= 200 && i <= 202 ? 20 : 1)) / t.mark }));
      },
      funding: async (coin) => ticks.filter((t) => t.coin === coin && t.ts % HOUR === 0).map((t) => ({ t: t.ts, rate: t.funding, premium: 0 })),
      now: () => end + GRID_MS,
      top: 3,
      params,
    }));
    expect(asked).toEqual(["BRK", "WASH", "CROWD"]);
    expect(r).toMatchObject({ state: "ok", source: "candles", grid: "15m", coins: ["BRK", "WASH", "CROWD"] });
    expect(r.horizons).toEqual(["1h", "4h", "24h", "72h"]);
    for (const k of ["crowded_long", "negative_funding_squeeze", "deleveraging_washout"]) {
      expect(r.setups.filter((s) => s.kind === k).every((s) => !s.evaluable && s.entries === 0 && s.reason?.includes("oiChg1hZ"))).toBe(true);
    }
    expect(r.setups.find((s) => s.kind === "vol_expansion_breakout" && s.side === "long")!.entries).toBeGreaterThan(0);
    expect(Date.parse(r.window!.from)).toBeGreaterThanOrEqual(Math.min(...ticks.map((t) => t.ts)) - GRID_MS + DAY);
    expect(r.assumptions.some((a) => a.includes("not a Lab trial"))).toBe(true);
    const text = formatReplay(r);
    expect(text).toContain("coins (3): BRK WASH CROWD");
    expect(text).toMatch(/vol_expansion_breakout\s+long\s+24h\s+\d+/);
    expect(text).toContain("not evaluable on this stream:\n  crowded_long short: reads oiChg1hZ, which needs intraday open interest; the stream has none");
    expect(formatReplay({ ...r, state: "pending", setups: [] })).toBe("setup replay · source candles · state pending");
  });

  test("a coin whose fetch fails is dropped and named", async () => {
    const r = await runCandleReplay({
      universe: async () => [{ coin: "A", dayNtlVlm: 2 }, { coin: "B", dayNtlVlm: 1 }],
      candles: async (coin) => { if (coin === "B") throw new Error("HL 500"); return Array.from({ length: 200 }, (_, i) => candle(i, 100)); },
      funding: async () => [],
      now: () => T0 + 201 * GRID_MS,
      top: 2,
      params,
    });
    expect(r.coins).toEqual(["A"]);
    expect(r.assumptions).toContain("dropped (fetch failed or empty): B");
  });
});

describe("memoSeries", () => {
  test("a second call fetches only from the newest cached point", async () => {
    const calls: Array<[number, number]> = [];
    const f = memoSeries(async (_coin: string, s: number, e: number) => (calls.push([s, e]), Array.from({ length: (e - s) / 10 + 1 }, (_, i) => ({ t: s + i * 10 }))));
    expect((await f("A", 0, 100)).length).toBe(11);
    expect((await f("A", 20, 150)).map((x) => x.t)).toEqual([20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150]);
    expect(calls).toEqual([[0, 100], [100, 150]]);
  });
});

describe("createReplayService", () => {
  const deferred = <T,>() => {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const p = new Promise<T>((a, b) => ((resolve = a), (reject = b)));
    return { p, resolve, reject };
  };

  test("pending while the first run is in flight, then ok and memoised; one run at a time", async () => {
    let t = 0;
    let runs = 0;
    let d = deferred<string>();
    const svc = createReplayService({ run: () => (runs++, d.p), now: () => t, ttlMs: 100, retryMs: 50, waitMs: 5 });
    expect(await svc.get()).toEqual({ state: "pending" });
    expect(await svc.get()).toEqual({ state: "pending" });
    expect(runs).toBe(1);
    d.resolve("a");
    await d.p;
    expect(await svc.get()).toEqual({ state: "ok", value: "a" });
    expect(runs).toBe(1);
    // stale: served while the refresh runs
    t = 150;
    d = deferred<string>();
    expect(await svc.get()).toEqual({ state: "ok", value: "a" });
    expect(runs).toBe(2);
    d.resolve("b");
    await d.p;
    expect(await svc.get()).toEqual({ state: "ok", value: "b" });
  });

  test("a failed first run is `failed` until retryMs, then retried", async () => {
    let t = 0;
    let runs = 0;
    const svc = createReplayService({ run: async () => (runs++, Promise.reject(new Error("boom"))), now: () => t, ttlMs: 100, retryMs: 50, waitMs: 50 });
    expect(await svc.get()).toEqual({ state: "failed" });
    t = 10;
    expect(await svc.get()).toEqual({ state: "failed" });
    expect(runs).toBe(1);
    t = 60;
    await svc.get();
    expect(runs).toBe(2);
  });
});
