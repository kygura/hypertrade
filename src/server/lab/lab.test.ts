import { describe, expect, test } from "bun:test";
import { describeRule, LabSearchRequestSchema, parseFeatureId } from "../../shared/lab.js";
import { dailyReturns, quickScore, strategyReturns, windowStats } from "./backtest.js";
import { alignDaily, DAY_MS, dayGrid, rollingPercentile, rollingZ, rsi, buildFeatures, type LabDataset } from "./features.js";
import { evaluateRule, liveCheck, runSearch, LabError } from "./search.js";
import { deflatedSharpe, expectedMaxSharpe, normCdf, normInv } from "./stats.js";

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());

/**
 * ~11 years of daily data with one planted edge: while MVRV (an AR(1) series)
 * sits in its bottom fifth, the next day's return drifts up. Fear & Greed is
 * pure noise. The search should find the MVRV rule and the holdout should
 * still show it.
 */
function synthetic(seed = 7, days = 4200): LabDataset {
  const r = rng(seed);
  const grid = dayGrid(Date.UTC(2014, 0, 1), Date.UTC(2014, 0, 1) + (days - 1) * DAY_MS);
  const mvrv = new Float64Array(days);
  const fng = new Float64Array(days);
  const close = new Float64Array(days);
  let m = 0;
  for (let t = 0; t < days; t++) {
    m = 0.985 * m + 0.17 * gauss(r);
    mvrv[t] = 1.8 + m;
    fng[t] = Math.round(50 + 20 * gauss(r));
  }
  const sorted = [...mvrv].sort((a, b) => a - b);
  const low = sorted[Math.floor(days * 0.2)]!;
  close[0] = 100;
  for (let t = 1; t < days; t++) {
    const drift = mvrv[t - 1]! < low ? 0.006 : -0.0005;
    close[t] = close[t - 1]! * (1 + drift + 0.025 * gauss(r));
  }
  return { days: grid, close, bases: { "cm.btc.CapMVRVCur": mvrv, "fng.value": fng } };
}

describe("alignDaily", () => {
  const days = dayGrid(Date.UTC(2024, 0, 1), Date.UTC(2024, 0, 10));
  test("applies the publication lag", () => {
    const pts = [{ ts: Date.UTC(2024, 0, 1), value: 1 }, { ts: Date.UTC(2024, 0, 2), value: 2 }];
    const out = alignDaily(pts, days, 1);
    expect(Number.isNaN(out[0]!)).toBe(true); // day 1's value is not known until day 2
    expect(out[1]).toBe(1);
    expect(out[2]).toBe(2);
  });
  test("forward-fills short gaps, not long ones", () => {
    const out = alignDaily([{ ts: Date.UTC(2024, 0, 1, 15), value: 5 }], days, 0);
    expect(out[0]).toBe(5);
    expect(out[7]).toBe(5);
    expect(Number.isNaN(out[8]!)).toBe(true);
  });
  test("keeps the last intraday point of a day", () => {
    const out = alignDaily([{ ts: Date.UTC(2024, 0, 1, 1), value: 1 }, { ts: Date.UTC(2024, 0, 1, 23), value: 9 }], days, 0);
    expect(out[0]).toBe(9);
  });
});

describe("transforms", () => {
  test("rolling z of a constant-step ramp equals the textbook value", () => {
    const x = Float64Array.from({ length: 10 }, (_, i) => i);
    const z = rollingZ(x, 5);
    expect(Number.isNaN(z[3]!)).toBe(true);
    // window [0..4]: mean 2, sd sqrt(2.5); z of 4 = 2 / 1.5811
    expect(z[4]!).toBeCloseTo(2 / Math.sqrt(2.5), 6);
  });
  test("percentile rank of a new high is 100", () => {
    const x = Float64Array.from({ length: 10 }, (_, i) => i);
    expect(rollingPercentile(x, 5)[9]).toBe(100);
  });
  test("RSI of a monotonic rise is 100", () => {
    const x = Float64Array.from({ length: 30 }, (_, i) => i);
    expect(rsi(x, 14)[29]).toBe(100);
  });
  test("features are causal: changing the future leaves the past alone", () => {
    const ds = synthetic(3, 900);
    const a = buildFeatures(ds, ["cm.btc.CapMVRVCur"]);
    const future = { ...ds, bases: { "cm.btc.CapMVRVCur": Float64Array.from(ds.bases["cm.btc.CapMVRVCur"]!) } };
    for (let t = 600; t < 900; t++) future.bases["cm.btc.CapMVRVCur"]![t] = 99;
    const b = buildFeatures(future, ["cm.btc.CapMVRVCur"]);
    for (let f = 0; f < a.ids.length; f++) {
      for (let t = 0; t < 600; t++) {
        const u = a.values[f]![t]!;
        const v = b.values[f]![t]!;
        if (Number.isNaN(u)) expect(Number.isNaN(v)).toBe(true);
        else expect(v).toBe(u);
      }
    }
  });
  test("trending bases get no raw transform", () => {
    const fm = buildFeatures({ days: [0, 1], close: new Float64Array(2), bases: { "bc.hash-rate": new Float64Array([1, 2]) } }, ["bc.hash-rate"], ["raw", "roc7"]);
    expect(fm.ids).toEqual([]); // raw skipped; roc7 all-NaN on two points
  });
});

describe("backtest", () => {
  const close = Float64Array.from([100, 110, 99, 99, 108.9]);
  const r = dailyReturns(close);
  test("a signal at t earns t -> t+1 and pays cost on each change", () => {
    const sig = Uint8Array.from([1, 0, 0, 1, 0]);
    const out = strategyReturns(sig, r, "long", 0.001, 0, 4);
    expect(out[0]!).toBeCloseTo(0.1 - 0.001, 10); // entered at close 0, earned day 1
    expect(out[1]!).toBeCloseTo(-0.001, 10); // exit cost, no market return
    expect(out[2]!).toBeCloseTo(0, 10);
    expect(out[3]!).toBeCloseTo(0.1 - 0.001, 10);
  });
  test("short direction inverts the return", () => {
    const out = strategyReturns(Uint8Array.from([0, 1, 0, 0, 0]), r, "short", 0, 0, 4);
    expect(out[1]!).toBeCloseTo(0.1, 10); // 110 -> 99 is -10%
  });
  test("window stats count trades and wins", () => {
    const s = windowStats(Uint8Array.from([1, 0, 0, 1, 0]), r, "long", 0, 0, 4, dayGrid(0, 4 * DAY_MS));
    expect(s.trades).toBe(2);
    expect(s.winRate).toBe(1);
    expect(s.exposure).toBe(0.5);
    expect(s.totalReturnPct).toBeCloseTo(21, 6);
  });
  test("quickScore enforces exposure and trade limits", () => {
    const q = quickScore(Uint8Array.from([0, 0, 0, 0, 0]), r, "long", 0, 0, 4, { minExposure: 0.1, maxExposure: 1, minTrades: 1 });
    expect(Number.isNaN(q.sr)).toBe(true);
  });
});

describe("stats", () => {
  test("normal cdf and inverse round-trip", () => {
    for (const p of [0.001, 0.05, 0.5, 0.9, 0.999]) expect(normCdf(normInv(p))).toBeCloseTo(p, 5);
    expect(normInv(0.975)).toBeCloseTo(1.959964, 5);
  });
  test("more trials raise the bar and lower the deflated Sharpe", () => {
    expect(expectedMaxSharpe(1000, 0.0004)).toBeGreaterThan(expectedMaxSharpe(10, 0.0004));
    const few = deflatedSharpe(0.06, 2000, 0, 3, 10, 0.0004);
    const many = deflatedSharpe(0.06, 2000, 0, 3, 10_000, 0.0004);
    expect(many).toBeLessThan(few);
  });
});

describe("runSearch", () => {
  const opts = LabSearchRequestSchema.parse({ direction: "long", bases: ["cm.btc.CapMVRVCur", "fng.value"], effort: "quick", maxResults: 5 });

  test("finds the planted MVRV edge and it holds out of sample", () => {
    const res = runSearch(synthetic(), opts);
    expect(res.results.length).toBeGreaterThan(0);
    const top = res.results[0]!;
    expect(top.rule.conditions.some((c) => c.feature.startsWith("cm.btc.CapMVRVCur|"))).toBe(true);
    expect(top.walkForward!.sharpe).toBeGreaterThan(0.5);
    expect(top.outOfSample!.sharpe).toBeGreaterThan(0);
    expect(res.trials).toBeGreaterThan(100);
    expect(top.text.startsWith("LONG when ")).toBe(true);
    expect(top.equity.length).toBeGreaterThan(10);
  });

  test("the holdout cannot influence what the search picks", () => {
    const ds = synthetic();
    const a = runSearch(ds, opts);
    const trainEnd = ds.days.findIndex((d) => new Date(d).toISOString().slice(0, 10) === a.range.trainEnd);
    const scrambled: LabDataset = {
      days: ds.days,
      close: Float64Array.from(ds.close),
      bases: Object.fromEntries(Object.entries(ds.bases).map(([k, v]) => [k, Float64Array.from(v)])),
    };
    const r = rng(99);
    for (let t = trainEnd + 1; t < ds.days.length; t++) {
      scrambled.close[t] = scrambled.close[t - 1]! * (1 + 0.05 * gauss(r));
      scrambled.bases["cm.btc.CapMVRVCur"]![t] = 3 * r();
    }
    const b = runSearch(scrambled, opts);
    expect(b.results.map((x) => x.rule)).toEqual(a.results.map((x) => x.rule));
    expect(b.results[0]!.inSample).toEqual(a.results[0]!.inSample);
    expect(b.results[0]!.walkForward).toEqual(a.results[0]!.walkForward);
  });

  test("pure noise yields a low deflated Sharpe", () => {
    const ds = synthetic(11);
    const r = rng(5);
    // Replace the edge with noise: the price no longer depends on MVRV.
    for (let t = 1; t < ds.close.length; t++) ds.close[t] = ds.close[t - 1]! * (1 + 0.025 * gauss(r));
    const res = runSearch(ds, opts);
    for (const x of res.results) expect(x.deflatedSharpe ?? 0).toBeLessThan(0.95);
  });

  test("too little history is a LabError", () => {
    expect(() => runSearch(synthetic(1, 500), opts)).toThrow(LabError);
  });
});

describe("evaluateRule and liveCheck", () => {
  const ds = synthetic();
  test("a quantile rule gets walk-forward stats, a fixed one does not", () => {
    const q = evaluateRule(ds, { direction: "long", conditions: [{ feature: "cm.btc.CapMVRVCur|raw", op: "<", q: 0.2 }] });
    expect(q.walkForward).not.toBeNull();
    expect(q.rule.conditions[0]!.threshold).toBeGreaterThan(0);
    const fixed = evaluateRule(ds, { direction: "long", conditions: [{ feature: "cm.btc.CapMVRVCur|raw", op: "<", threshold: 1.5 }] });
    expect(fixed.walkForward).toBeNull();
    expect(fixed.outOfSample).not.toBeNull();
  });
  test("unknown data is a LabError", () => {
    expect(() => evaluateRule(ds, { direction: "long", conditions: [{ feature: "bc.hash-rate|roc30", op: ">", q: 0.5 }] })).toThrow(LabError);
  });
  test("liveCheck splits at the save date", () => {
    const rep = evaluateRule(ds, { direction: "long", conditions: [{ feature: "cm.btc.CapMVRVCur|raw", op: "<", q: 0.2 }] });
    const saved = new Date(ds.days[ds.days.length - 200]!).toISOString();
    const live = liveCheck(ds, rep.rule, saved);
    expect(live.sinceSaved!.days).toBe(199);
    expect(live.full.days).toBeGreaterThan(live.sinceSaved!.days);
  });
});

describe("shared lab vocabulary", () => {
  test("feature ids parse and rules render", () => {
    expect(parseFeatureId("cm.btc.CapMVRVCur|z365")?.base.label).toBe("MVRV");
    expect(parseFeatureId("nope|z365")).toBeNull();
    const text = describeRule({
      direction: "long",
      conditions: [
        { feature: "cm.btc.CapMVRVCur|z365", op: "<", threshold: -0.853 },
        { feature: "bc.hash-rate|roc30", op: ">", threshold: 0.031 },
      ],
    });
    expect(text).toBe("LONG when MVRV 365d z-score < -0.85 AND Hash rate 30d change > +3.1%");
  });
});
