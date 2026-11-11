import { describe, expect, test } from "bun:test";
import { ENDPOINT_TOLERANCE_MS } from "../intel/windows.js";
import { computeFeatures, FEATURE_MIN_TICKS_24H, type RingPoint } from "./features.js";
import { snapshotStreams } from "./replaySource.js";
import type { Info } from "./scanner.js";
import { MemoryPlatformStore } from "./store-memory.js";
import { runPlatformTick, type PlatformTickDeps } from "./tick.js";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const NOW = Date.UTC(2026, 9, 20, 12); // no FOMC/CPI within a day
const quiet = { log: () => {}, logError: () => {} };

const ctx = (mark: number, over: Record<string, string> = {}) => ({
  funding: "0.00001", openInterest: String(1e8 / mark), prevDayPx: String(mark), dayNtlVlm: "500000000", premium: "0", oraclePx: String(mark), markPx: String(mark), midPx: String(mark), impactPxs: null, dayBaseVlm: "1", ...over,
});
const book = (mark: number) => ({
  levels: [
    Array.from({ length: 20 }, (_, i) => ({ px: String(mark * (1 - 0.0002 * (i + 1))), sz: String(5e4 / mark), n: 1 })),
    Array.from({ length: 20 }, (_, i) => ({ px: String(mark * (1 + 0.0002 * (i + 1))), sz: String(5e4 / mark), n: 1 })),
  ],
});
/** HL info stub: every coin's ctx from `ctxOf(coin)`, books at the same mark. */
const infoOf = (coins: string[], ctxOf: (coin: string) => ReturnType<typeof ctx>, calls: string[] = []) =>
  (async (body: { type: string; coin?: string }) => {
    calls.push(body.type);
    if (body.type === "l2Book") return book(Number(ctxOf(body.coin!).markPx));
    return [{ universe: coins.map((name) => ({ name, szDecimals: 3, maxLeverage: 20 })) }, coins.map(ctxOf)];
  }) as Info;

/** 24 h of 1-min points ending at `end`; `pump` ends in a 15-min +3% run with OI and volume building (scanner.test.ts). */
function ring(pump: boolean, end: number): RingPoint[] {
  const N = 24 * 60;
  let mark = 100;
  return Array.from({ length: N }, (_, i) => {
    mark *= Math.exp(i % 2 ? -0.0005 : 0.0005 + (i % 7 === 0 ? 0.0002 : 0));
    const p = { ts: end - (N - 1 - i) * MIN, mark, oiUsd: 1e8 + (i % 5) * 1e5, funding: 1e-5 + (i % 3) * 1e-6, dayNtlVlm: 5e8 + (i % 11) * 1e6 };
    return pump && i >= N - 15 ? { ...p, mark: p.mark * (1 + 0.03 * ((i - (N - 16)) / 15)), oiUsd: p.oiUsd * 1.05, dayNtlVlm: p.dayNtlVlm * 1.2 } : p;
  });
}
const rows = (coin: string, pts: RingPoint[]) => pts.map((p) => ({ coin, ts: new Date(p.ts).toISOString(), inputs: { mark: p.mark, oiUsd: p.oiUsd, funding: p.funding, dayNtlVlm: p.dayNtlVlm } }));

const base = (store: MemoryPlatformStore, info: Info, now: () => number): PlatformTickDeps => ({ store, info, now, candles: async () => [], ...quiet });

describe("runPlatformTick", () => {
  test("a tick writes one snapshot row per live coin, runs the steps in order and reports counts", async () => {
    const store = new MemoryPlatformStore();
    const coins = ["A", "B", "C"];
    const r = await runPlatformTick(base(store, infoOf(coins, () => ctx(100)), () => NOW));
    expect(r.ok).toBe(true);
    expect(r.steps.map((s) => [s.name, s.status])).toEqual([["scanner", "ok"], ["novelty", "skipped"], ["outcomes", "ok"], ["prune", "ok"]]);
    expect(r.steps[1]).toEqual({ name: "novelty", status: "skipped", reason: "not configured" });
    expect(r.snapshotRows).toBe(3);
    expect((await store.scanSnapshotsSince(new Date(NOW - MIN).toISOString())).map((s) => s.coin).sort()).toEqual(coins);
    expect(r.candidates).toBe(0);
    expect(r.opportunities).toEqual({ upserted: 0, created: 0 });
    expect(r.pruned).toBe(0);
  });

  test("a firing setup is counted as a candidate and an upserted, created opportunity", async () => {
    const store = new MemoryPlatformStore();
    const pumped = ring(true, NOW);
    const coins = ["PUMP", "A", "B", "C", "D", "E"];
    await store.insertScanSnapshots(coins.flatMap((c) => rows(c, c === "PUMP" ? pumped : ring(false, NOW))));
    const last = pumped.at(-1)!;
    const info = infoOf(coins, (c) => (c === "PUMP" ? ctx(last.mark * 1.002, { openInterest: String(last.oiUsd / (last.mark * 1.002)), dayNtlVlm: String(last.dayNtlVlm) }) : ctx(100)));
    const r = await runPlatformTick(base(store, info, () => NOW + MIN));
    const opps = await store.listOpportunities({ limit: 50 });
    expect(opps.length).toBeGreaterThan(0);
    expect(r.candidates).toBe(opps.length);
    expect(r.opportunities).toEqual({ upserted: opps.length, created: opps.length });
    expect(r.ringMinutes).toBeGreaterThan(23 * 60);
  });

  test("a failing step is reported and the later steps still run", async () => {
    const store = new MemoryPlatformStore();
    const info = (async () => Promise.reject(new Error("HL down"))) as Info;
    const r = await runPlatformTick(base(store, info, () => NOW));
    expect(r.ok).toBe(false);
    expect(r.failed).toEqual(["scanner"]);
    expect(r.steps.find((s) => s.name === "scanner")).toMatchObject({ status: "failed", error: "HL down" });
    expect(r.steps.filter((s) => s.status === "ok").map((s) => s.name)).toEqual(["outcomes", "prune"]);
  });

  test("deadline: once the scan has used the budget, outcomes and prune are skipped with a reason", async () => {
    const store = new MemoryPlatformStore();
    let t = NOW;
    const inner = infoOf(["A"], () => ctx(100));
    const info = (async (b: { type: string }) => ((t += 190_000), inner(b))) as Info;
    const r = await runPlatformTick(base(store, info, () => t), { deadline: NOW + 200_000, reserveMs: { scanner: 60_000, outcomes: 30_000, prune: 15_000 } });
    expect(r.steps.map((s) => [s.name, s.status])).toEqual([["scanner", "ok"], ["novelty", "skipped"], ["outcomes", "skipped"], ["prune", "skipped"]]);
    expect(r.steps[2]).toEqual({ name: "outcomes", status: "skipped", reason: "deadline: 10000 ms left, step needs 30000 ms" });
    expect(r.pruned).toBeNull();
  });

  test("skip: a skipped step's factory is never called", async () => {
    let built = 0;
    const deps = { ...base(new MemoryPlatformStore(), infoOf(["A"], () => ctx(100)), () => NOW), novelty: () => (built++, { tick: async () => {} }) };
    const r = await runPlatformTick(deps, { skip: ["novelty"], skipReason: { novelty: "excluded" } });
    expect(built).toBe(0);
    expect(r.steps[1]).toEqual({ name: "novelty", status: "skipped", reason: "excluded" });
    await runPlatformTick(deps);
    expect(built).toBe(1);
  });
});

describe("tick cadence vs the features' density rule", () => {
  /** Runs a fresh tick (as each HTTP call does) every `everyMin` minutes for a day, then reads coin A's ring from storage. */
  async function day(everyMin: number) {
    const store = new MemoryPlatformStore();
    let t = NOW - DAY;
    // A slow wave in mark, OI, funding and volume so the z features have dispersion.
    const ctxAt = () => {
      const k = (t - NOW) / (37 * MIN);
      const m = 100 * (1 + 0.004 * Math.sin(k) + 0.001 * Math.sin(3.1 * k));
      return ctx(m, { funding: String(1e-5 * (1 + 0.3 * Math.sin(1.7 * k))), openInterest: String((1e8 * (1 + 0.01 * Math.sin(0.9 * k))) / m), dayNtlVlm: String(5e8 * (1 + 0.05 * Math.sin(1.3 * k))) });
    };
    let last;
    for (; t <= NOW; t += everyMin * MIN) last = await runPlatformTick(base(store, infoOf(["A"], ctxAt), () => t));
    const pts = (snapshotStreams(await store.scanSnapshotsSince(new Date(NOW - DAY).toISOString())).get("A") ?? []).filter((p) => p.ts > NOW - DAY);
    const maxGap = Math.max(...pts.slice(1).map((p, i) => p.ts - pts[i]!.ts));
    return { pts, maxGap, last: last! };
  }

  test("ticks 15 minutes apart: >= 96 ring points in 24 h, no gap over 20 min, and the setup features compute", async () => {
    const { pts, maxGap, last } = await day(15);
    expect(pts.length).toBeGreaterThanOrEqual(FEATURE_MIN_TICKS_24H);
    expect(maxGap).toBeLessThanOrEqual(ENDPOINT_TOLERANCE_MS);
    // The next tick's scanner seeds exactly this ring from scan_snapshots.
    expect(last.ringMinutes).toBeGreaterThanOrEqual(24 * 60 - 15);
    const fv = computeFeatures(pts, NOW);
    for (const k of ["ret15mZ", "priceAccelZ", "oiChg1hZ", "fundingZ24h", "fundingPctile24h", "volRatio1hZ", "rvExpansion"]) expect(fv.features[k]).not.toBeNull();
  });

  test("contrast: hourly ticks break both halves of the rule and leave the 24 h funding features null", async () => {
    const { pts, maxGap } = await day(60);
    expect(pts.length).toBeLessThan(FEATURE_MIN_TICKS_24H);
    expect(maxGap).toBeGreaterThan(ENDPOINT_TOLERANCE_MS);
    const fv = computeFeatures(pts, NOW);
    for (const k of ["fundingZ24h", "fundingPctile24h"]) expect(fv.features[k]).toBeNull();
  });
});
