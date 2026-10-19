import { describe, expect, test } from "bun:test";
import { bullEpisodes, cycleAnalogs, forecastNextRun, quantile } from "./cycleForecast.js";
import { commitWithHysteresis, computeCycle, DAY_MS, fillGaps, percentileRank, resampleWeekly, sma, type DailyBar } from "./cycles.js";
import daily from "./fixtures/cycles/btc-daily.json";

// BTC/USD daily closes 2011-09-13 → 2026-10-18 (Bitstamp, then Hyperliquid
// from 2020-08), gap-filled, 5 significant figures.
function dailyBars(fx: { from: string; c: number[] }): DailyBar[] {
  const t0 = Date.parse(`${fx.from}T00:00:00Z`);
  return fx.c.map((c, i) => ({ t: t0 + i * DAY_MS, o: c, h: c, l: c, c, v: 0, src: "fixture" }));
}

const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const month = (t: number) => iso(t).slice(0, 7);
const bars = dailyBars(daily);
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

  test("finds the four bull runs and dates each by euphoria and by breakout", () => {
    const eps = bullEpisodes(points);
    expect(eps.map((e) => iso(e.start))).toEqual(["2013-03-29", "2017-03-02", "2020-12-20", "2024-03-03"]);
    // The final doubling into euphoria: October of the year before since 2016.
    expect(eps.map((e) => iso(e.breakout.t))).toEqual(["2013-03-13", "2016-10-20", "2020-10-19", "2023-10-23"]);
    for (const e of eps) {
      expect(e.breakout.price).toBeGreaterThan(e.startPrice / 2);
      expect(e.breakout.t).toBeLessThanOrEqual(e.start);
    }
    // 2013 ties at $1,132 to 5 significant figures (Nov 29 and Dec 4); the first wins.
    expect(eps.map((e) => [iso(e.top.t), e.top.price])).toEqual([
      ["2013-11-29", 1132],
      ["2017-12-16", 19188],
      ["2021-11-08", 67607],
      ["2025-10-06", 124710],
    ]);
    expect(eps.map((e) => e.low && month(e.low.t))).toEqual(["2015-01", "2018-12", "2022-11", "2026-06"]);
    expect(eps.map((e) => e.lowConfirmed)).toEqual([true, true, true, false]);
  });
});

describe("forecastNextRun", () => {
  const f = forecastNextRun(points);
  const fe = forecastNextRun(points, { kind: "euphoria" });

  test("projects each method from its own anchor with every past offset", () => {
    expect(f.status).toBe("between_runs");
    expect(f.kind).toBe("breakout");
    const byKey = Object.fromEntries(f.methods.map((m) => [m.key, m]));
    expect(Object.keys(byKey).sort()).toEqual(["halving", "low", "rhythm", "top"]);
    expect(byKey.rhythm!.samples.map((s) => s.cycle)).toEqual([2016, 2020, 2023]);
    expect(byKey.rhythm!.anchor.t).toBe(Date.UTC(2023, 9, 23));
    expect(byKey.halving!.samples).toHaveLength(4);
    // The 2023 breakout came six months before its halving.
    expect(byKey.halving!.samples[3]!.days).toBe(-180);
    for (const m of f.methods) for (const s of m.samples) expect(s.date).toBe(m.anchor.t + s.days * DAY_MS);
  });

  test("pools the candidates into a run-start window; breakout dates it earlier", () => {
    for (const x of [f, fe]) {
      const o = x.onset!;
      expect(o.min).toBeLessThanOrEqual(o.p25);
      expect(o.p25).toBeLessThanOrEqual(o.median);
      expect(o.median).toBeLessThanOrEqual(o.p75);
      expect(o.p75).toBeLessThanOrEqual(o.max);
      expect(x.top!.median).toBeGreaterThan(o.median);
    }
    expect(month(f.onset!.median)).toBe("2028-01");
    expect(month(fe.onset!.median)).toBe("2028-05");
    // The 2020→2023 breakout gap (1099d) repeated lands on the fixture's own month.
    expect(month(f.onset!.min)).toBe("2026-10");
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
    expect(a[2]!.onsetDay).toBe(846);
    expect(a[2]!.breakoutDay).toBe(714);
    expect(a[3]!.points[a[3]!.points.length - 1]!.r).toBeCloseTo(points[points.length - 1]!.c / a[3]!.topPrice, 6);
  });
});

test("quantile interpolates", () => {
  expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
});
