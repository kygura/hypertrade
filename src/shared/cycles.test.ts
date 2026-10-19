import { describe, expect, test } from "bun:test";
import { bullEpisodes, cycleAnalogs, forecastNextRun, quantile } from "./cycleForecast.js";
import { commitWithHysteresis, computeCycle, DAY_MS, fillGaps, percentileRank, resampleWeekly, sma, type DailyBar } from "./cycles.js";
import weekly from "./fixtures/cycles/btc-weekly.json";

// BTC/USD weekly closes 2011-09 → 2026-10 ([day number, close]), the daily
// history the route serves thinned to one close a week to keep the fixture small.
// Log-linear interpolation rebuilds a daily series close enough for the model.
function dailyFromWeekly(rows: number[][]): DailyBar[] {
  const out: DailyBar[] = [];
  for (let i = 0; i < rows.length - 1; i++) {
    const [d0, c0] = rows[i]! as [number, number];
    const [d1, c1] = rows[i + 1]! as [number, number];
    for (let d = d0; d < d1; d++) {
      const c = c0 * Math.pow(c1 / c0, (d - d0) / (d1 - d0));
      out.push({ t: d * DAY_MS, o: c, h: c, l: c, c, v: 0, src: "fixture" });
    }
  }
  const [dl, cl] = rows[rows.length - 1]! as [number, number];
  out.push({ t: dl * DAY_MS, o: cl, h: cl, l: cl, c: cl, v: 0, src: "fixture" });
  return out;
}

const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const month = (t: number) => iso(t).slice(0, 7);
const bars = dailyFromWeekly(weekly as number[][]);
const asOf = bars[bars.length - 1]!.t + DAY_MS;
const points = computeCycle(bars, asOf);

describe("indicators", () => {
  test("sma is null through warm-up, then the trailing mean", () => {
    expect(sma([1, 2, 3, 4], 3)).toEqual([null, null, 2, 3]);
  });

  test("percentileRank counts ties as half and respects min", () => {
    expect(percentileRank([1, 2, 2, null, 3], 5, 2)).toEqual([null, 0.75, 2 / 3, null, 0.875]);
  });

  test("hysteresis needs a full run (or maxAway) before switching", () => {
    const raw = ["a", "b", "a", "b", "b", "b", null, "c"] as const;
    expect(commitWithHysteresis([...raw], () => 3)).toEqual(["a", "a", "a", "a", "a", "b", null, "b"]);
    expect(commitWithHysteresis(["a", "b", "c", "b", "c"], () => 9, 3)).toEqual(["a", "a", "a", "b", "b"]);
  });

  test("fillGaps forward-fills missing days at the previous close", () => {
    const t = Date.UTC(2024, 0, 1);
    const out = fillGaps([
      { t, o: 1, h: 1, l: 1, c: 2, v: 5, src: "hl" },
      { t: t + 3 * DAY_MS + 3_600_000, o: 3, h: 3, l: 3, c: 3, v: 5, src: "hl" },
    ]);
    expect(out.map((b) => [b.t, b.c, b.v])).toEqual([
      [t, 2, 5],
      [t + DAY_MS, 2, 0],
      [t + 2 * DAY_MS, 2, 0],
      [t + 3 * DAY_MS, 3, 5],
    ]);
  });
});

describe("cycle model on BTC history", () => {
  test("drops the unclosed bar and spans 2011 to the fixture's end", () => {
    expect(computeCycle(bars, bars[bars.length - 1]!.t + 1).length).toBe(points.length - 1);
    expect(iso(points[0]!.t)).toBe("2011-09-13");
  });

  test("weekly bars start on Mondays and carry the week's last phase", () => {
    const w = resampleWeekly(points);
    expect(w.every((p) => new Date(p.t).getUTCDay() === 1)).toBe(true);
    expect(w[w.length - 1]!.phase).toBe(points[points.length - 1]!.phase);
  });

  test("finds the four bull runs: 2013, 2017, early 2021 and 2024", () => {
    const eps = bullEpisodes(points);
    // Daily closes put the 2017 and 2020 onsets at 2017-03-02 and 2020-12-20;
    // the interpolated weekly fixture reads a few weeks earlier.
    expect(eps.map((e) => month(e.start))).toEqual(["2013-03", "2017-02", "2020-11", "2024-03"]);
    expect(eps.map((e) => month(e.top.t))).toEqual(["2013-12", "2017-12", "2021-11", "2025-10"]);
    expect(eps.map((e) => e.low && month(e.low.t))).toEqual(["2015-01", "2018-12", "2022-11", "2026-06"]);
    expect(eps.map((e) => e.lowConfirmed)).toEqual([true, true, true, false]);
  });
});

describe("forecastNextRun", () => {
  const f = forecastNextRun(points);

  test("projects each method from its own anchor with every past offset", () => {
    expect(f.status).toBe("between_runs");
    const byKey = Object.fromEntries(f.methods.map((m) => [m.key, m]));
    expect(Object.keys(byKey).sort()).toEqual(["halving", "low", "rhythm", "top"]);
    expect(byKey.rhythm!.samples.map((s) => s.cycle)).toEqual([2017, 2020, 2024]);
    expect(byKey.halving!.samples).toHaveLength(4);
    // 2024's run started before its halving.
    expect(byKey.halving!.samples[3]!.days).toBeLessThan(0);
    for (const m of f.methods) for (const s of m.samples) expect(s.date).toBe(m.anchor.t + s.days * DAY_MS);
  });

  test("pools the candidates into a 2027-2029 onset window", () => {
    const o = f.onset!;
    expect(o.min).toBeLessThanOrEqual(o.p25);
    expect(o.p25).toBeLessThanOrEqual(o.median);
    expect(o.median).toBeLessThanOrEqual(o.p75);
    expect(o.p75).toBeLessThanOrEqual(o.max);
    expect(iso(o.min) >= "2027-01-01").toBe(true);
    expect(iso(o.max) < "2029-07-01").toBe(true);
    expect(iso(o.median).slice(0, 4)).toBe("2028");
    expect(f.top!.median).toBeGreaterThan(o.median);
  });

  test("reads today's position against the last top", () => {
    const r = f.readiness!;
    expect(r.priorBearDepths).toHaveLength(3);
    for (const d of r.priorBearDepths) expect(d).toBeLessThan(-0.7);
    expect(r.lowDepth!).toBeGreaterThan(-0.6);
    expect(r.elapsed!).toBeGreaterThan(0.2);
    expect(r.elapsed!).toBeLessThan(0.5);
  });

  test("returns no estimate without two runs, and none while a run is live", () => {
    expect(forecastNextRun(points.slice(0, 2200)).onset).toBeNull();
    const live = points.filter((p) => p.t <= Date.UTC(2024, 3, 1));
    const fl = forecastNextRun(live);
    expect(fl.status).toBe("in_run");
    expect(fl.methods).toEqual([]);
  });
});

describe("cycleAnalogs", () => {
  test("indexes each cycle to its top and marks the live one", () => {
    const a = cycleAnalogs(points, bullEpisodes(points));
    expect(a.map((x) => x.label)).toEqual(["2013", "2017", "2021", "2025"]);
    for (const x of a) expect(x.points[0]).toEqual({ d: 0, r: 1 });
    expect(a.map((x) => x.current)).toEqual([false, false, false, true]);
    expect(a[3]!.onsetDay).toBeNull();
    expect(a[2]!.onsetDay).toBeGreaterThan(800);
    expect(a[3]!.points[a[3]!.points.length - 1]!.r).toBeCloseTo(points[points.length - 1]!.c / a[3]!.topPrice, 6);
  });
});

test("quantile interpolates", () => {
  expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
});
