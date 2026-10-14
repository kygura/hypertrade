import { describe, expect, test } from "bun:test";
import type { FlowRow, SnapshotRow } from "../../shared/intel.js";
import type { Point } from "./normalize.js";
import {
  computeWindows,
  DEFAULT_THRESHOLDS,
  parseThresholds,
  pickWindow,
  regimeFlags,
  robustLevelZ,
  robustSigma,
  seriesFromRows,
  valueAt,
  windowResult,
} from "./windows.js";

const MIN = 60_000;
const H = 60 * MIN;
const D = 24 * H;
const NOW = Date.parse("2026-10-14T12:00:00Z");
/** Deterministic noise in (−1, 1). */
const rnd = (i: number) => (Math.sin(i * 12.9898 + 78.233) * 43758.5453) % 1;

/** 15-min samples from now − span to now; f(t, i) gives the value. */
function series(spanMs: number, f: (t: number, i: number) => number, stepMs = 15 * MIN): Point[] {
  const out: Point[] = [];
  for (let t = NOW - spanMs, i = 0; t <= NOW; t += stepMs, i++) out.push({ t, v: f(t, i) });
  return out;
}

/** A noisy random walk (log returns ±0.2% per step) ending at `now`; `last` overrides the final hour's moves. */
function walk(spanMs: number, start: number, lastHourPct = 0, seed = 0): Point[] {
  let v = start;
  return series(spanMs, (t, i) => {
    if (i > 0) v *= Math.exp(0.002 * rnd(i + seed) + (t > NOW - H ? lastHourPct / 100 / 4 : 0));
    return v;
  });
}

describe("valueAt", () => {
  const pts = [{ t: NOW - 60 * MIN, v: 1 }, { t: NOW - 19 * MIN, v: 2 }];
  test("nearest sample within ±20 min of the grid point, else null", () => {
    expect(valueAt(pts, NOW)).toBe(2);
    expect(valueAt(pts, NOW - 40 * MIN)).toBe(1); // 20 vs 21 min away: the nearer one
    expect(valueAt(pts, NOW + 2 * MIN)).toBeNull(); // 21 min
    expect(valueAt(pts, NOW - 80 * MIN)).toBe(1);
    expect(valueAt([], NOW)).toBeNull();
  });
});

describe("robustSigma", () => {
  test("MAD × 1.4826, floored", () => {
    expect(robustSigma([1, 2, 3, 4, 100], 0)).toBeCloseTo(1.4826, 10); // the outlier does not move it
    expect(robustSigma([5, 5, 5, 5], 1e-6)).toBe(1e-6);
  });
});

describe("windowResult", () => {
  test("1h needs 48 non-overlapping Δs in the trailing 30 days", () => {
    const enough = walk(49 * H, 100);
    const short = enough.filter((p) => p.t >= NOW - 48 * H);
    expect(windowResult("price", enough, NOW, "1h").z).not.toBeNull();
    expect(windowResult("price", short, NOW, "1h").z).toBeNull();
    expect(windowResult("price", short, NOW, "1h").delta).not.toBeNull(); // Δ shown even without z
  });

  test("6h needs 20, 24h needs 30 within 90 days", () => {
    const p = walk(32 * D, 100);
    expect(windowResult("price", p.filter((x) => x.t >= NOW - 21 * 6 * H), NOW, "6h").z).not.toBeNull();
    expect(windowResult("price", p.filter((x) => x.t >= NOW - 20 * 6 * H), NOW, "6h").z).toBeNull();
    expect(windowResult("price", p.filter((x) => x.t >= NOW - 31 * D), NOW, "24h").z).not.toBeNull();
    expect(windowResult("price", p.filter((x) => x.t >= NOW - 30 * D), NOW, "24h").z).toBeNull();
  });

  test("a large last-hour move reads as a large z; delta is the pct change", () => {
    const p = walk(10 * D, 100, 3);
    const r = windowResult("price", p, NOW, "1h");
    expect(r.z!).toBeGreaterThan(5);
    const a = valueAt(p, NOW - H)!;
    expect(r.delta).toBeCloseTo((valueAt(p, NOW)! / a - 1) * 100, 10);
    expect(windowResult("price", walk(10 * D, 100), NOW, "1h").z!).toBeLessThan(3);
  });

  test("hourly-stepped funding: the σ floor (1e-6/h) keeps z finite", () => {
    const f = series(10 * D, (t) => (t > NOW - 30 * MIN ? 1.2e-5 : 1e-5));
    const r = windowResult("funding", f, NOW, "1h");
    expect(r.delta).toBeCloseTo(2e-6, 15);
    expect(r.z).toBeCloseTo(2, 6); // MAD of past Δs is 0 → σ = floor
  });

  test("per-interval flows: delta is the window total, z on log(1 + total)", () => {
    const liq = series(10 * D, (t) => (t > NOW - H ? 100_000 : 1_000 * (1 + 0.1 * rnd(t / MIN))));
    const r = windowResult("liq_usd", liq, NOW, "1h");
    expect(r.delta).toBeCloseTo(400_000, 6); // 4 intervals in (now − 1h, now]
    expect(r.z!).toBeGreaterThan(10);
  });

  test("a missing endpoint (gap > 20 min) gives no Δ and no z", () => {
    const p = walk(10 * D, 100).filter((x) => x.t < NOW - H - 25 * MIN || x.t > NOW - H + 25 * MIN);
    expect(windowResult("price", p, NOW, "1h")).toEqual({ metric: "price", window: "1h", delta: null, z: null });
  });

  test("computeWindows covers every metric × window, null without a series", () => {
    const all = computeWindows({ price: walk(10 * D, 100) }, NOW);
    expect(all.length).toBe(12 * 3);
    expect(pickWindow(all, "price", "6h")!.z).not.toBeNull();
    expect(pickWindow(all, "spot_volume_usd", "24h")).toEqual({ metric: "spot_volume_usd", window: "24h", delta: null, z: null });
  });
});

describe("robustLevelZ", () => {
  test("value at now vs the 30-day median and robust σ; null under 48 samples", () => {
    const f = series(5 * D, (t, i) => (t === NOW ? 5e-5 : 1e-5 + 1e-6 * rnd(i)));
    expect(robustLevelZ("funding", f, NOW)!).toBeGreaterThan(10);
    expect(robustLevelZ("funding", f.slice(-47), NOW)).toBeNull();
  });
});

describe("seriesFromRows", () => {
  const snap = (ts: string, over: Partial<SnapshotRow> = {}): SnapshotRow => ({
    asset: "BTC", ts, price: 1, vol24h: null, funding: null, oiUsd: null, premium: null, basis: null,
    depthBid1: null, depthAsk1: null, depthBid2: null, depthAsk2: null, spreadBps: null, ...over,
  });
  const flow = (metric: FlowRow["metric"], ts: string, value: number): FlowRow => ({ asset: "BTC", venue: "agg", metric, value, ts });

  test("depth_2 = bid + ask, liq_usd = long + short, HL oi/funding only, ascending", () => {
    const s = seriesFromRows(
      [snap("2026-10-14T00:15:00Z", { price: 2, depthBid2: 1, depthAsk2: 2, oiUsd: 7 }), snap("2026-10-14T00:00:00Z", { depthBid2: 5 })],
      [
        flow("liq_long_usd", "2026-10-14T00:00:00Z", 10),
        flow("liq_short_usd", "2026-10-14T00:00:00Z", 5),
        flow("oi_usd", "2026-10-14T00:00:00Z", 99),
        flow("spot_volume_usd", "2026-10-14T00:00:00Z", 3),
      ],
    );
    expect(s.price!.map((p) => p.v)).toEqual([1, 2]);
    expect(s.depth_2!.map((p) => p.v)).toEqual([3]);
    expect(s.oi_usd!.map((p) => p.v)).toEqual([7]);
    expect(s.liq_usd!.map((p) => p.v)).toEqual([15]);
    expect(s.spot_volume_usd!.map((p) => p.v)).toEqual([3]);
    expect(s.funding).toBeUndefined();
  });
});

describe("parseThresholds", () => {
  test("default is funding > 0.05%/8h hourly; bad entries are skipped", () => {
    expect(parseThresholds(undefined)).toEqual([{ metric: "funding", op: ">", value: 0.0000625 }]);
    expect(parseThresholds("")).toEqual(parseThresholds(DEFAULT_THRESHOLDS));
    expect(parseThresholds(" basis<-0.001 , nope>1, funding>abc, spread_bps>5")).toEqual([
      { metric: "basis", op: "<", value: -0.001 },
      { metric: "spread_bps", op: ">", value: 5 },
    ]);
  });
});

describe("regimeFlags", () => {
  const T = parseThresholds(undefined);
  const names = (flags: ReturnType<typeof regimeFlags>, window: string) => flags.filter((f) => f.window === window).map((f) => f.name);

  test("funding sign flip and threshold crossing fire on the transition only", () => {
    const flipped = series(3 * D, (t) => (t > NOW - 30 * MIN ? -1e-5 : 1e-5));
    const now = regimeFlags("BTC", { funding: flipped }, NOW, T);
    expect(names(now, "1h")).toEqual(["funding_flip"]);
    expect(now.find((f) => f.window === "1h")).toMatchObject({ kind: "flip", asset: "BTC", numbers: { from: 1e-5, to: -1e-5 }, degraded: false, ts: new Date(NOW).toISOString() });
    const held = series(3 * D, (t) => (t > NOW - 2 * D ? -1e-5 : 1e-5));
    expect(names(regimeFlags("BTC", { funding: held }, NOW, T), "1h")).toEqual([]);
    expect(names(regimeFlags("BTC", { funding: held }, NOW, T), "24h")).toEqual([]);

    const crossed = series(3 * D, (t) => (t > NOW - 30 * MIN ? 8e-5 : 1e-5));
    const c = regimeFlags("BTC", { funding: crossed }, NOW, T).filter((f) => f.kind === "crossing");
    expect(c.map((f) => f.window)).toEqual(["1h", "6h", "24h"]);
    expect(c[0]).toMatchObject({ name: "funding>0.0000625", numbers: { from: 1e-5, to: 8e-5, threshold: 0.0000625 } });
    const stays = series(3 * D, (t) => (t > NOW - 2 * D ? 8e-5 : 1e-5));
    expect(regimeFlags("BTC", { funding: stays }, NOW, T).filter((f) => f.kind === "crossing")).toEqual([]);
  });

  test("basis inversion is a flip", () => {
    const b = series(2 * D, (t) => (t > NOW - 3 * H ? -2e-4 : 1e-4));
    expect(names(regimeFlags("BTC", { basis: b }, NOW, []), "6h")).toEqual(["basis_flip"]);
    expect(names(regimeFlags("BTC", { basis: b }, NOW, []), "1h")).toEqual([]);
  });

  test("OI up while price down: emitted when the previous window did not hold it", () => {
    const fresh = { price: walk(10 * D, 100, -3, 1), oi_usd: walk(10 * D, 1e9, 3, 2) };
    const f = regimeFlags("BTC", fresh, NOW, []).filter((x) => x.name === "oi_up_price_down" && x.window === "1h");
    expect(f.length).toBe(1);
    expect(f[0]!.numbers.oi_z!).toBeGreaterThanOrEqual(1);
    expect(f[0]!.numbers.price_z!).toBeLessThanOrEqual(-1);
    expect(f[0]!.score).toBe(Math.max(Math.abs(f[0]!.numbers.oi_z!), Math.abs(f[0]!.numbers.price_z!)));
    // the same move over the previous hour too: the state already held at the window start
    const twoHours = (p: Point[], pct: number) => p.map((x, i) => (x.t > NOW - 2 * H ? { ...x, v: x.v * Math.exp((pct / 100 / 4) * (i - p.findIndex((y) => y.t > NOW - 2 * H) + 1)) } : x));
    const held = { price: twoHours(walk(10 * D, 100, 0, 1), -3), oi_usd: twoHours(walk(10 * D, 1e9, 0, 2), 3) };
    expect(windowResult("oi_usd", held.oi_usd, NOW, "1h").z!).toBeGreaterThanOrEqual(1); // the condition holds now…
    expect(windowResult("price", held.price, NOW, "1h").z!).toBeLessThanOrEqual(-1);
    expect(regimeFlags("BTC", held, NOW, []).filter((x) => x.name === "oi_up_price_down" && x.window === "1h")).toEqual([]);
  });

  test("no series → no flags", () => {
    expect(regimeFlags("BTC", {}, NOW, T)).toEqual([]);
  });
});
