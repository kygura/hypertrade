import { describe, expect, test } from "bun:test";
import { ExtremeCalibrationResultSchema, type ExtremeCalibrationResult, type ExtremeEvent } from "../../shared/extremes.js";
import {
  calibrateExtremes, calibrateFromReadings, calibrationFloor, calibrationAlert, calibrationParams, calibrationTable, cappedRate, collectReadings, denseDays, eventsFromReadings, looser,
  multiplierOf, universeFromStreams, withMultiplier, type CalibrateOpts,
} from "./calibrate.js";
import { DEFAULT_EXTREME_THRESHOLDS as D, readExtremes } from "./detect.js";
import { BAR_MS as BAR, fixture, N, T0 } from "./calibrate.fixture.js";
import { replayExtremes } from "./replay.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const COOLDOWN = 24 * HOUR;

/** Steps every 3 h from the first one with 14 days of history to the end (the grid is any ascending list; 3 h keeps the suite fast). */
const GRID = Array.from({ length: 16 * 8 }, (_, k) => T0 + 14 * DAY + (k + 1) * 3 * HOUR).filter((t) => t <= T0 + (N - 1) * BAR);
const SLOW = 30_000;
const STREAMS = fixture();
const LIMITS = calibrationParams({}).limits;
const opts = (over: Partial<CalibrateOpts> = {}): CalibrateOpts => ({
  streams: STREAMS, grid: GRID, current: D, targets: { perWeek: 1, min: 0.5, max: 1.5 }, limits: LIMITS, cooldownMs: COOLDOWN, ...over,
});
const FLOOR = calibrationFloor(D, LIMITS);
const STEPS = collectReadings({ streams: STREAMS, grid: GRID, floor: FLOOR });
const kindOf = (r: ExtremeCalibrationResult, kind: string) => r.kinds.find((k) => k.kind === kind)!;
const decide = (over: Partial<CalibrateOpts> = {}) => calibrateFromReadings(opts(over), STEPS);
const BASE = decide();

describe("fast path parity", () => {
  test("re-thresholded stored readings give exactly replayExtremes' events (same cooldown, same order)", () => {
    const sets = [FLOOR, withMultiplier(withMultiplier(D, "price_dislocation", 1.3), "crowded_asymmetry", 0.8)];
    let total = 0;
    for (const th of sets) {
      const slow = replayExtremes({ streams: STREAMS, grid: GRID, thresholds: th, cooldownMs: COOLDOWN }).events;
      expect(eventsFromReadings(STEPS, th, COOLDOWN)).toEqual(slow);
      total += slow.length;
    }
    // the fixture exercises every kind
    const kinds = new Set(eventsFromReadings(STEPS, FLOOR, COOLDOWN).map((e) => e.kind));
    expect([...kinds].sort()).toEqual(["crowded_asymmetry", "oi_flush", "price_dislocation"]);
    expect(total).toBeGreaterThan(10);
  }, SLOW);

  test("monotonic: a larger multiplier never fires more (readings and events)", () => {
    for (const kind of ["price_dislocation", "oi_flush", "crowded_asymmetry"] as const) {
      const counts = [0.5, 0.75, 1, 1.5, 2, 2.5].map((k) => eventsFromReadings(STEPS, withMultiplier(D, kind, k), COOLDOWN).filter((e) => e.kind === kind).length);
      for (let i = 1; i < counts.length; i++) expect(counts[i]!).toBeLessThanOrEqual(counts[i - 1]!);
      expect(counts[0]!).toBeGreaterThanOrEqual(counts.at(-1)!);
    }
    const pd = [0.5, 2.5].map((k) => eventsFromReadings(STEPS, withMultiplier(D, "price_dislocation", k), COOLDOWN).filter((e) => e.kind === "price_dislocation").length);
    expect(pd[0]!).toBeGreaterThan(pd[1]!);
  });

  test("the knob: one parameter family per kind, floors untouched; multiplierOf reads it back", () => {
    const p = withMultiplier(D, "price_dislocation", 2);
    expect(p.price.z["24h"]).toBe(D.price.z["24h"] * 2);
    expect(p.price.zResid["72h"]).toBe(D.price.zResid["72h"] * 2);
    expect(p.price.minMove).toEqual(D.price.minMove);
    expect({ ...p, price: D.price }).toEqual(D);
    const o = withMultiplier(D, "oi_flush", 0.5);
    expect(o.oiFlush).toEqual({ z: { "1h": 5, "4h": 4, "24h": 3 }, minDrop: D.oiFlush.minDrop, zPrice: 1.5 });
    const c = withMultiplier(D, "crowded_asymmetry", 1.2);
    expect(c.crowded).toEqual({ ...D.crowded, minAprPct: 90 });
    expect([multiplierOf(p, "price_dislocation"), multiplierOf(o, "oi_flush"), multiplierOf(c, "crowded_asymmetry"), multiplierOf(c, "oi_flush")]).toEqual([2, 0.5, 1.2, 1]);
    // looser: every cut the lower, maxFollowZ the higher
    const l = looser(c, { ...o, crowded: { ...o.crowded, maxFollowZ: 1 } });
    expect([l.oiFlush.z["1h"], l.crowded.minAprPct, l.crowded.maxFollowZ]).toEqual([5, 75, 1]);
  });
});

describe("cappedRate", () => {
  const e = (coin: string, kind = "price_dislocation"): ExtremeEvent => ({ key: `${kind}|${coin}|long`, kind: kind as never, coin, side: "long", ts: "", window: "24h", mark: 1, severity: 1, facts: {}, line: "x" });
  test("each coin counts at most `cap` events: one coin cannot carry the rate", () => {
    const evs = [...Array.from({ length: 7 }, () => e("AAA")), e("BBB"), e("CCC"), e("CCC"), e("CCC"), e("DDD", "oi_flush")];
    expect(cappedRate(evs, "price_dislocation", 2, 2)).toEqual({ events: 11, rate: (2 + 1 + 2) / 2, top: { coin: "AAA", events: 7 } });
    expect(cappedRate(evs, "oi_flush", 0, 2)).toEqual({ events: 1, rate: null, top: { coin: "DDD", events: 1 } });
    expect(cappedRate([], "oi_flush", 1, 2)).toEqual({ events: 0, rate: 0, top: null });
  });
});

describe("universe and density", () => {
  test("universe at a step: top N by the latest volume stored in the hour before it, plus BTC; stale coins drop out", () => {
    const s = new Map(STREAMS);
    s.set("OLD", STREAMS.get("AAA")!.filter((p) => p.ts < T0 + 20 * DAY).map((p) => ({ ...p, dayNtlVlm: 1e12 })));
    const u = universeFromStreams(s, 2);
    expect([...u(T0 + 19 * DAY)].sort()).toEqual(["BTC", "OLD"]);
    expect([...u(T0 + 21 * DAY)].sort()).toEqual(["AAA", "BTC"]);
    // readings outside the universe are never taken
    const only = collectReadings({ streams: STREAMS, grid: GRID, floor: FLOOR, universe: () => new Set(["BTC", "BBB"]) });
    expect(new Set(only.flatMap((s) => s.readings.map((r) => r.coin)))).toEqual(new Set(["BBB"]));
  });

  test("denseDays counts whole 24 h windows back from the end until one is thin", () => {
    expect(denseDays(STREAMS, T0 + (N - 1) * BAR)).toBe(30);
    const gap = new Map([...STREAMS].map(([c, pts]) => [c, pts.filter((p) => p.ts < T0 + 20 * DAY || p.ts > T0 + 21 * DAY)]));
    expect(denseDays(gap, T0 + (N - 1) * BAR)).toBe(9);
  });
});

describe("calibrateExtremes", () => {

  test("calibrateExtremes takes its own readings and decides as calibrateFromReadings does", () => {
    expect(calibrateExtremes(opts())).toEqual(BASE);
  }, SLOW);

  test("the result parses as stored, and the busiest coin is reported", () => {
    expect(ExtremeCalibrationResultSchema.parse(BASE)).toEqual(BASE);
    const pd = kindOf(BASE, "price_dislocation");
    expect(pd.evaluable).toBe(true);
    expect(pd.topCoinBefore!.coin).toBe("AAA");
    expect(pd.eventsBefore).toBeGreaterThan(pd.rateBefore! * BASE.weeks); // the cap bit
    expect(BASE.denseDays).toBe(30);
  });

  // The fixture's rates (3 h grid, 2.25 weeks, cap 2): price 2.67/wk at k <= 1.25, 2.22 at 1.3..1.45, 1.78 at 1.5..1.55,
  // 0.89 from 1.6, 0 from 1.875; oi_flush 0.89 at k = 1; crowded 0.89 at k = 1.
  const price = (r: ExtremeCalibrationResult) => kindOf(r, "price_dislocation");
  const rateAt = (k: number) => cappedRate(eventsFromReadings(STEPS, withMultiplier(D, "price_dislocation", k), COOLDOWN), "price_dislocation", BASE.weeks, 2).rate!;

  test("in band: nothing changes (hysteresis)", () => {
    expect(kindOf(BASE, "oi_flush")).toMatchObject({ changed: false, unchanged: "in_band", multiplier: 1 });
    expect(kindOf(BASE, "oi_flush").rateBefore!).toBeCloseTo(0.89, 2);
    expect(kindOf(BASE, "crowded_asymmetry")).toMatchObject({ changed: false, unchanged: "in_band", multiplier: 1 });
    expect(BASE.thresholds.oiFlush).toBe(D.oiFlush);
  });

  test("out of band but nothing within this run's ±25% does better: unchanged (clamped)", () => {
    expect(price(BASE)).toMatchObject({ changed: false, unchanged: "clamped", multiplier: 1 });
    expect([price(BASE).rateBefore!, price(BASE).rateAfter!]).toEqual([rateAt(1), rateAt(1)]);
    expect(rateAt(1)).toBeCloseTo(2.67, 2);
    expect(BASE.thresholds).toEqual(D);
  });

  test("out of band: moves toward the target, nearest it, ties to the multiplier closest to the applied one", () => {
    const r = decide({ current: withMultiplier(D, "price_dislocation", 1.4), targets: { perWeek: 0.5, min: 0.3, max: 0.7 } });
    const pd = price(r);
    expect(pd).toMatchObject({ multiplierBefore: 1.4, changed: true, unchanged: null, limited: null });
    expect([pd.rateBefore!, pd.rateAfter!]).toEqual([rateAt(1.4), rateAt(1.6)]);
    expect(pd.multiplier).toBeGreaterThan(1.55);
    expect(pd.multiplier).toBeLessThan(1.65); // the first candidate past the drop, not the step's 1.75
    expect(rateAt(pd.multiplier)).toBeCloseTo(0.89, 2);
    // the returned thresholds are exactly the knob at the chosen multiplier; an unchanged kind keeps its section
    expect(r.thresholds.price).toEqual(withMultiplier(D, "price_dislocation", pd.multiplier).price);
    expect(kindOf(r, "oi_flush")).toMatchObject({ changed: false, unchanged: "clamped" });
    expect(r.thresholds.oiFlush).toBe(D.oiFlush);
    const crowded = kindOf(r, "crowded_asymmetry"); // 0.89 -> 0.44 a week: nearer 0.5
    expect(crowded.changed).toBe(true);
    expect(r.thresholds.crowded).toEqual(withMultiplier(D, "crowded_asymmetry", crowded.multiplier).crowded);
  });

  test("at most ±25% a run (step), and within [0.5, 2.5] of the code defaults (clamp)", () => {
    const step = price(decide({ current: withMultiplier(D, "price_dislocation", 1.2), targets: { perWeek: 0.2, min: 0.1, max: 0.3 } }));
    expect(step).toMatchObject({ changed: true, multiplier: 1.5, limited: "step" });
    expect(step.rateAfter!).toBeCloseTo(1.78, 2);
    // the lowest multiplier at which price drops to 0.89, as the cumulative ceiling: the bound is the only better candidate
    let c = 1.55;
    while (rateAt(c) > 1) c = Math.round((c + 0.001) * 1000) / 1000;
    const clamp = price(decide({ current: withMultiplier(D, "price_dislocation", 1.5), targets: { perWeek: 0.2, min: 0.1, max: 0.3 }, limits: { ...LIMITS, maxMultiplier: c } }));
    expect(clamp).toMatchObject({ changed: true, multiplier: c, limited: "clamp" });
  });

  test("not evaluable: too little dense history or replayed span keeps everything; OI kinds without OI", () => {
    const thin = decide({ limits: { ...LIMITS, minDenseDays: 40 } });
    for (const k of thin.kinds) expect(k).toMatchObject({ evaluable: false, changed: false, unchanged: "not_evaluable", rateBefore: null, multiplier: 1 });
    expect(thin.kinds[0]!.reason).toMatch(/30 days of dense history, needs 40/);
    expect(thin.thresholds).toEqual(D);
    const short = decide({ grid: GRID.slice(-8 * 5) });
    expect(short.kinds.every((k) => !k.evaluable && /days replayed, needs 7/.test(k.reason!))).toBe(true);
    const noOi = decide({ streams: new Map([...STREAMS].map(([c, pts]) => [c, pts.map((p) => ({ ...p, oiUsd: NaN }))])), targets: { perWeek: 20, min: 15, max: 25 } });
    expect(noOi.kinds.map((k) => [k.kind, k.evaluable])).toEqual([["price_dislocation", true], ["oi_flush", false], ["crowded_asymmetry", false]]);
    expect(noOi.thresholds.oiFlush).toEqual(D.oiFlush);
  });

  test("frequency only and no look-ahead: points after the last step change the forward returns, never the decision", () => {
    const end = GRID.at(-25)!;
    const wild = new Map([...STREAMS].map(([c, pts]) => [c, pts.map((p) => (p.ts > end ? { ...p, mark: p.mark * (c === "AAA" ? 3 : 0.2) } : p))]));
    const t = { perWeek: 0.2, min: 0.1, max: 0.3 };
    const grid = GRID.slice(0, -24);
    const a = calibrateFromReadings(opts({ targets: t, grid }), STEPS.filter((s) => s.now <= grid.at(-1)!));
    const b = calibrateExtremes(opts({ targets: t, grid, streams: wild }));
    const strip = (r: ExtremeCalibrationResult) => r.kinds.map(({ forwardBefore: _a, forwardAfter: _b, ...k }) => k);
    expect(strip(b)).toEqual(strip(a));
    expect(b.thresholds).toEqual(a.thresholds);
    expect(b.kinds.map((k) => k.forwardBefore)).not.toEqual(a.kinds.map((k) => k.forwardBefore));
  }, SLOW);

  test("readings are those of readExtremes under the floor (the stored inputs the fast path re-thresholds)", () => {
    const s = STEPS[0]!;
    const r = s.readings[0]!;
    expect(readExtremes({ coin: r.coin, points: STREAMS.get(r.coin)!, btc: r.coin === "BTC" ? null : STREAMS.get("BTC")!, now: s.now }, FLOOR)).toEqual(r);
  });
});

describe("params and output", () => {
  test("env overrides; an inconsistent band falls back to the defaults", () => {
    expect(calibrationParams({})).toEqual({
      targets: { perWeek: 1, min: 0.5, max: 1.5 },
      limits: { minDenseDays: 14, minReplayDays: 7, maxStep: 0.25, minMultiplier: 0.5, maxMultiplier: 2.5, perCoinCap: 2 },
    });
    const p = calibrationParams({ EXTREMES_CALIBRATION_TARGET_WK: "2", EXTREMES_CALIBRATION_MAX_WK: "3", EXTREMES_CALIBRATION_MIN_DAYS: "10", EXTREMES_CALIBRATION_PER_COIN_CAP: "1.5" });
    expect(p.targets).toEqual({ perWeek: 2, min: 0.5, max: 3 });
    expect(p.limits).toMatchObject({ minDenseDays: 10, perCoinCap: 2 });
    expect(calibrationParams({ EXTREMES_CALIBRATION_TARGET_WK: "5" }).targets).toEqual({ perWeek: 1, min: 0.5, max: 1.5 });
  });

  test("one info push only when a kind changed, facts only; the table", () => {
    const k = (kind: string, over: object) => ({ ...kindOf(BASE, kind), ...over });
    const r: ExtremeCalibrationResult = {
      ...BASE,
      kinds: [
        k("price_dislocation", { changed: false, unchanged: "in_band", rateBefore: 1.1, rateAfter: 1.1 }),
        k("oi_flush", { changed: true, unchanged: null, multiplier: 0.8, rateBefore: 0.2, rateAfter: 0.9 }),
        k("crowded_asymmetry", { changed: false, evaluable: false, unchanged: "not_evaluable", reason: "reads OI", rateBefore: null, rateAfter: null }),
      ] as never,
    };
    expect(calibrationAlert(r)).toEqual({
      level: "info", title: "Extremes recalibrated",
      body: "price_dislocation unchanged (1.1/wk), oi_flush ×0.80 (0.2 → 0.9/wk), crowded_asymmetry not evaluable",
    });
    expect(calibrationAlert({ ...r, kinds: r.kinds.map((x) => ({ ...x, changed: false })) })).toBeNull();
    const table = calibrationTable(r, { id: 7, applied: true });
    expect(table[0]).toMatch(/^Extremes calibration #7: .* applied$/);
    expect(table.find((l) => l.startsWith("| oi_flush"))).toMatch(/\| 0\.2 → 0\.9 \| .* \| 1\.00 → 0\.80 \| yes \|$/);
    expect(table.find((l) => l.startsWith("| crowded_asymmetry"))).toMatch(/no \(reads OI\) \|$/);
  });
});
