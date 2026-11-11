// Ported from hl-cycles backend/test/vector-model.test.ts (MODEL §8): compass, regime, staleness, levels.
import { describe, expect, test } from "bun:test";
import { computeCycle, type DailyBar } from "./cycles.js";
import regressionFx from "./fixtures/vector/regression-inputs.json";
import type { RegimeState } from "./vector.js";
import { bandOf, carry, computeCompass, HEADLINE_BANDS, inputPct, inputScore, meanIfHalf, type CompassInput, type LensSpec } from "./vectorCompass.js";
import {
  rawState,
  commitRegime,
  riskOffShare,
  levelStatus,
  flipsOf,
  stateSince,
  wocPhase,
  htfNote,
  momentumScore,
  buildVector,
  type VectorHtfPoint,
} from "./vectorModel.js";
import type { Row } from "./vectorCompass.js";

const DAY = 86_400_000;
const T0 = Date.UTC(2024, 5, 1);
const inp = (values: (number | null)[], polarity: 1 | -1 = 1): CompassInput => ({ key: "x", label: "x", unit: "ratio", polarity, values, asOf: null });

describe("compass percentile and polarity (D4)", () => {
  test("expanding window: null before 365 values, then rank includes today", () => {
    const xs = Array.from({ length: 400 }, (_, i) => i);
    const p = inputPct(inp(xs));
    expect(p[363]).toBeNull();
    expect(p[364]).toBeCloseTo(((364 + 0.5) / 365) * 100, 9);
    expect(p[399]).toBeCloseTo(((399 + 0.5) / 400) * 100, 9);
  });

  test("polarity −1 mirrors the score, pct stays raw", () => {
    const xs = Array.from({ length: 400 }, (_, i) => i);
    expect(inputScore(inp(xs, -1))[399]).toBeCloseTo(100 - ((399 + 0.5) / 400) * 100, 9);
  });

  test("rolling 4y window forgets values older than 1460 days", () => {
    // 500 huge values, then 1460 small rising ones: the last value is the window max.
    const xs = [...Array(500).fill(1e9), ...Array.from({ length: 1460 }, (_, i) => i)];
    expect(inputPct(inp(xs))[xs.length - 1]).toBeCloseTo(((1459 + 0.5) / 1460) * 100, 9);
  });

  test("raw (breadth) inputs are scored as-is", () => {
    expect(inputPct({ values: [42], raw: true })[0]).toBe(42);
  });

  test("lens = mean of non-null inputs, null when fewer than half are present", () => {
    expect(meanIfHalf([[10], [null], [30], [null]], 1)[0]).toBe(20); // 2 of 4 = half
    expect(meanIfHalf([[10], [null], [null], [null]], 1)[0]).toBeNull();
    expect(meanIfHalf([[10], [20], [null], [null], [null]], 1)[0]).toBeNull(); // 2 of 5
    expect(meanIfHalf([[10], [20], [30], [null], [null]], 1)[0]).toBe(20); // 3 of 5
  });

  test("headline averages only the four forward lenses; bands at 20/40/60/80", () => {
    const lens = (key: string, v: number, standalone = false): LensSpec => ({
      key, label: key, standalone, bands: HEADLINE_BANDS, inputs: [{ ...inp([v]), raw: true }],
    });
    const { headline, lenses } = computeCompass(
      [lens("macro", 10), lens("flows", 20), lens("behaviour", 30), lens("fundamentals", 40), lens("cycle", 100, true)],
      1,
    );
    expect(headline[0]).toBe(25);
    expect(lenses[4]!.score[0]).toBe(100);
    expect([0, 19.9, 20, 59.9, 80, 100].map((s) => bandOf(s, HEADLINE_BANDS))).toEqual([
      "Risk-Off", "Risk-Off", "Defensive", "Neutral", "Risk-On", "Risk-On",
    ]);
  });
});

describe("regime raw state (MODEL §8.3)", () => {
  test("four-state rule", () => {
    expect(rawState(0, 10, 1)).toBe("strong_risk_on");
    expect(rawState(0, 10, -1)).toBe("mild_risk_on");
    expect(rawState(0, 10, null)).toBe("mild_risk_on");
    expect(rawState(1 / 6, 10, 1)).toBe("mild_risk_on");
    expect(rawState(2 / 6, 10, 1)).toBe("mild_risk_off");
    expect(rawState(0.5, -1, 1)).toBe("strong_risk_off");
    expect(rawState(0.5, 1, 1)).toBe("mild_risk_off");
    expect(rawState(1 / 6, -5, 1)).toBe("mild_risk_off");
    expect(rawState(null, 10, 1)).toBeNull();
  });

  test("riskOff never renormalises: a missing condition counts as not stressed", () => {
    expect(riskOffShare([true, null, false, true, null, null])).toBeCloseTo(2 / 6, 12);
  });

  test("a new state commits only after 3 consecutive closes", () => {
    const on: RegimeState = "mild_risk_on";
    const off: RegimeState = "mild_risk_off";
    expect(commitRegime([on, on, off, off, on, off, off, off])).toEqual([on, on, on, on, on, on, on, off]);
  });

  test("flips are extreme-to-extreme only; since = start of the current state", () => {
    const s: RegimeState[] = ["strong_risk_off", "mild_risk_off", "mild_risk_on", "mild_risk_off", "strong_risk_on", "mild_risk_on", "strong_risk_on"];
    const t = s.map((_, i) => T0 + i * DAY);
    const f = flipsOf(t, s, s.map((_, i) => 100 + i));
    expect(f).toEqual([{ t: T0 + 4 * DAY, from: "mild_risk_off", to: "strong_risk_on", price: 104 }]);
    expect(stateSince(t, s)).toBe(T0 + 6 * DAY);
  });

  test("momentum is bounded and signed", () => {
    const up = Array.from({ length: 300 }, (_, i) => 100 * 1.01 ** i);
    const m = momentumScore(up);
    expect(m[199]).toBeNull();
    expect(m[299]!).toBeGreaterThan(0);
    expect(m[299]!).toBeLessThanOrEqual(100);
    expect(momentumScore([...up].reverse())[299]!).toBeLessThan(0);
  });

  test("momentum matches the closed form on a constant log-return path", () => {
    const r = 0.002;
    const c = Array.from({ length: 260 }, (_, i) => Math.exp(r * i));
    // ln(c[i]/c[i-k]) = r·k, so each leg is tanh(r·√k / σ).
    const expected = (100 * [20, 50, 200].reduce((a, k) => a + Math.tanh((r * Math.sqrt(k)) / 0.035), 0)) / 3;
    expect(momentumScore(c)[250]!).toBeCloseTo(expected, 9);
  });
});

describe("carry-forward and staleness (D5)", () => {
  test("carry fills at most 10 days", () => {
    const c = carry([1, ...Array(12).fill(null)], 10);
    expect(c.slice(0, 11)).toEqual(Array(11).fill(1));
    expect(c[11]).toBeNull();
  });

  // 700 synthetic daily candles: a steady uptrend so the regime is defined at the end.
  const candles: DailyBar[] = Array.from({ length: 700 }, (_, i) => {
    const c = 20_000 * 1.002 ** i * (1 + 0.02 * Math.sin(i / 7));
    return { t: T0 + i * DAY, o: c, h: c, l: c, c, v: 1, src: "bitstamp" };
  });
  const htf = computeCycle(candles, T0 + 700 * DAY);
  const last = htf[htf.length - 1]!.t;
  const rows = (endAgo: number, f: (c: number, i: number) => number) =>
    htf.filter((p) => p.t <= last - endAgo * DAY).map((p, i) => ({ t: p.t, v: f(p.c, i) }));
  const data = (cbAgo: number) => ({
    htf,
    series: {
      "sth-realized-price": rows(cbAgo, (c) => c * 1.5), // above price: the condition is stressed while fresh
      "true-market-mean": rows(0, (c) => c * 0.8),
      "sth-sopr": rows(0, () => 1.02),
      totalStablecoinMcapUSD: rows(0, (_, i) => 1e11 + i * 1e8),
      RealizedCapUSD: rows(0, (_, i) => 1e11 + i * 1e8),
    },
    funding: [],
    oi: [],
    alts: [],
    sources: {},
  });

  test("an input up to 10 days old is carried and counted", () => {
    const v = buildVector(data(5));
    const cond = v.regime.conditions.find((c) => c.key === "price_below_sth")!;
    expect(cond.on).toBe(true);
    expect(v.stale).toBe(true); // etf-flow-btc missing entirely after 2024 is stale too
    expect(cond.asOf).toBe(last - 5 * DAY);
  });

  test("beyond 10 days the input counts as not stressed and marks the regime stale", () => {
    const fresh = buildVector({ ...data(5), series: { ...data(5).series, "etf-flow-btc": rows(0, () => 10) } });
    const old = buildVector({ ...data(12), series: { ...data(12).series, "etf-flow-btc": rows(0, () => 10) } });
    expect(fresh.stale).toBe(false);
    expect(old.stale).toBe(true);
    expect(old.regime.conditions.find((c) => c.key === "price_below_sth")!.on).toBe(false);
    expect(old.oldestInputAsOf).toBe(last - 12 * DAY);
  });

  test("ETF tail: zero-filled up to the last row, carried after it; revised when delayed rows land", () => {
    const etfCond = (v: ReturnType<typeof buildVector>) => v.regime.conditions.find((c) => c.key === "etf_outflow_7d")!;
    // Rows end 3 days before the last close, with one interior day (last-5) missing.
    const etf = rows(3, () => 10).filter((r) => r.t !== last - 5 * DAY);
    const base = data(0);
    const v = buildVector({ ...base, series: { ...base.series, "etf-flow-btc": etf } });
    expect(etfCond(v).value).toBe(60); // days last-9..last-3, the gap read as 0, carried to the last close
    expect(etfCond(v).on).toBe(false);
    const late = [-3, -2, -1, 0].map((k) => ({ t: last + k * DAY, v: k === -3 ? 10 : -100 }));
    const revised = buildVector({ ...base, series: { ...base.series, "etf-flow-btc": [...etf.filter((r) => r.t < last - 3 * DAY), ...late] } });
    expect(etfCond(revised).value).toBe(-270);
    expect(etfCond(revised).on).toBe(true);
  });
});

describe("D5: ETF before its launch", () => {
  test("a 2023 regime without ETF rows reads the ETF condition false and is not stale", () => {
    const t0 = Date.UTC(2022, 0, 1);
    const candles: DailyBar[] = Array.from({ length: 700 }, (_, i) => {
      const c = 20_000 * 1.002 ** i * (1 + 0.02 * Math.sin(i / 7));
      return { t: t0 + i * DAY, o: c, h: c, l: c, c, v: 1, src: "bitstamp" };
    });
    const htf = computeCycle(candles, t0 + 700 * DAY);
    const end = htf[htf.length - 1]!.t;
    expect(end).toBeLessThan(Date.UTC(2024, 0, 11));
    const rows = (f: (c: number, i: number) => number) => htf.map((p, i) => ({ t: p.t, v: f(p.c, i) }));
    const v = buildVector({
      htf,
      series: {
        "sth-realized-price": rows((c) => c * 0.9),
        "true-market-mean": rows((c) => c * 0.8),
        "sth-sopr": rows(() => 1.02),
        totalStablecoinMcapUSD: rows((_, i) => 1e11 + i * 1e8),
        RealizedCapUSD: rows((_, i) => 1e11 + i * 1e8),
      },
      funding: [], oi: [], alts: [], sources: {},
    });
    const etf = v.regime.conditions.find((c) => c.key === "etf_outflow_7d")!;
    expect(v.regime.state).not.toBeNull();
    expect(etf.on).toBe(false);
    expect(etf.asOf).toBe(end);
    expect(v.stale).toBe(false);
  });
});

describe("levels, WoC phase, D7 note", () => {
  test("level status over the last two closes", () => {
    const lv = [11, 11];
    expect(levelStatus([12, 13], lv, 1)).toBe("holding");
    expect(levelStatus([10, 9], lv, 1)).toBe("lost");
    expect(levelStatus([10, 12], lv, 1)).toBe("contested");
    expect(levelStatus([12, 10], lv, 1)).toBe("contested");
    expect(levelStatus([12, 10], [null, 11], 1)).toBeNull();
    expect(levelStatus([11, 11], lv, 1)).toBe("lost"); // price == level counts as below (MODEL §8.4)
  });

  test("WoC phase rule", () => {
    expect(wocPhase(100, 90, 95)).toBe("strong_uptrend");
    expect(wocPhase(80, 90, 95)).toBe("capitulation");
    expect(wocPhase(80, 95, 90)).toBe("bear");
    expect(wocPhase(92, 90, 95)).toBe("transition");
    expect(wocPhase(92, null, 95)).toBeNull();
  });

  test("htfNote follows the DESIGN 14.4.1 table exactly", () => {
    expect(htfNote("strong_risk_on", "distribution")).toBe("HTF phase reads DISTRIBUTION — the cycle frame disagrees with the regime.");
    expect(htfNote("mild_risk_on", "markdown")).not.toBeNull();
    expect(htfNote("mild_risk_off", "expansion")).toBe("HTF phase reads EXPANSION — the cycle frame disagrees with the regime.");
    expect(htfNote("mild_risk_off", "accumulation")).toBeNull();
    expect(htfNote("strong_risk_on", "euphoria")).toBeNull();
    expect(htfNote("strong_risk_off", "euphoria")).toBeNull();
    expect(htfNote(null, "expansion")).toBeNull();
  });
});

// Frozen-input regression, copied from hl-cycles (test/vector-regression.test.ts and its fixture: real data
// trimmed to the series the regime and the Compass headline need, 2022-09-01 -> 2026-09-28, price from 2021-08
// for warm-up). Same expected values as hl-cycles: the port must reproduce its model exactly.
describe("vector regression (frozen real inputs, parity with hl-cycles)", () => {
  type Daily = { start: string; v: (number | null)[] };
  const D = (s: string) => Date.parse(`${s}T00:00:00Z`);
  const toRows = ({ start, v }: Daily): Row[] => v.flatMap((x, i) => (x == null ? [] : [{ t: D(start) + i * DAY, v: x }]));
  const fx = regressionFx as unknown as {
    htf: { start: string; c: number[]; heat: (number | null)[]; sma200: (number | null)[]; phase: VectorHtfPoint["phase"][] };
    series: Record<string, Daily>;
  };
  const h = fx.htf;
  const htf: VectorHtfPoint[] = h.c.map((c, i) => ({ t: D(h.start) + i * DAY, c, heat: h.heat[i]!, sma200: h.sma200[i]!, phase: h.phase[i]! }));
  const series = Object.fromEntries(Object.entries(fx.series).map(([k, d]) => [k, toRows(d)]));
  const v = buildVector({ htf, series, funding: [], oi: [], alts: [], sources: {} });
  const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
  const at = (day: string) => v.history.find((p) => p.t === D(day))!;
  const compassAt = (day: string) => v.compass.history.find((p) => p.t === D(day))!;

  test("regime start day", () => {
    expect(iso(v.history.find((p) => p.state != null)!.t)).toBe("2022-10-07");
  });

  test("full flip list", () => {
    expect(v.flips.map((f) => [iso(f.t), f.from, f.to])).toEqual([
      ["2023-10-28", "mild_risk_on", "strong_risk_on"],
      ["2024-05-02", "mild_risk_off", "strong_risk_off"],
      ["2024-06-01", "mild_risk_on", "strong_risk_on"],
      ["2024-06-26", "mild_risk_off", "strong_risk_off"],
      ["2024-09-28", "mild_risk_on", "strong_risk_on"],
      ["2025-02-27", "mild_risk_off", "strong_risk_off"],
      ["2025-05-04", "mild_risk_on", "strong_risk_on"],
      ["2025-08-31", "mild_risk_off", "strong_risk_off"],
      ["2025-09-15", "mild_risk_on", "strong_risk_on"],
      ["2025-10-23", "mild_risk_off", "strong_risk_off"],
      ["2026-05-06", "mild_risk_off", "strong_risk_on"],
      ["2026-05-21", "strong_risk_on", "strong_risk_off"],
      ["2026-08-26", "mild_risk_on", "strong_risk_on"],
    ]);
  });

  test("anchors: riskOff, momentum, compass headline", () => {
    const anchors: [string, number, number, number][] = [
      ["2023-11-15", 0, 65.5, 72.9],
      ["2025-02-27", 0.667, -16.3, 40.5],
      ["2026-09-28", 0, 49.1, 49.8],
    ];
    for (const [day, riskOff, momentum, headline] of anchors) {
      expect(at(day).riskOff!).toBeCloseTo(riskOff, 4);
      expect(at(day).momentum!).toBeCloseTo(momentum, 4);
      expect(compassAt(day).headline!).toBeCloseTo(headline, 4);
    }
  });

  test("price is the last daily close; every gauge and lens key is present", () => {
    expect(v.price).toBe(Math.round(h.c[h.c.length - 1]! * 100) / 100);
    expect(Object.keys(v.gauges).sort()).toEqual(["flows", "fundamentals", "momentum", "risk"]);
    expect(v.compass.lenses.map((l) => l.key)).toEqual(["macro", "flows", "behaviour", "fundamentals", "cycle", "derivatives", "rotation"]);
    expect(v.levels.map((l) => l.key)).toContain("sth_cost_basis");
  });
});

describe("empty inputs", () => {
  test("no price history gives an all-null payload, not a throw", () => {
    const v = buildVector({ htf: [], series: {}, funding: [], oi: [], alts: [], sources: { "btc-price": { lastOk: null, lastError: "down" } } });
    expect(v.asOf).toBeNull();
    expect(v.price).toBeNull();
    expect(v.regime.state).toBeNull();
    expect(v.stale).toBe(true);
    expect(v.levels.every((l) => l.value == null)).toBe(true);
    expect(v.sources["btc-price"]!.lastError).toBe("down");
  });
});

describe("rotation and derivatives inputs", () => {
  const t0 = Date.UTC(2023, 0, 1);
  const n = 400;
  const bars: DailyBar[] = Array.from({ length: n }, (_, i) => {
    const c = 20_000 * 1.001 ** i;
    return { t: t0 + i * DAY, o: c, h: c, l: c, c, v: 1, src: "fx" };
  });
  const htf = computeCycle(bars, t0 + n * DAY);
  const last = htf[htf.length - 1]!.t;
  const hourly = (rate: number) => Array.from({ length: 24 * 10 }, (_, k) => ({ t: last - 9 * DAY + k * 3_600_000, rate, premium: 0.0001 }));
  // Six alts: four outrun BTC over 30d (2%/day vs 0.1%/day), two lag it; three run hot funding.
  const alts = Array.from({ length: 6 }, (_, j) => ({
    coin: `ALT${j}`,
    closes: htf.map((p, i) => ({ t: p.t, v: 10 * (j < 4 ? 1.02 : 0.99) ** i })),
    funding: hourly(j < 3 ? 0.0001 : 0.0000125),
  }));
  const v = buildVector({ htf, series: {}, funding: hourly(0.0000125), oi: [], alts, sources: {} });
  const input = (lens: string, key: string) => v.compass.lenses.find((l) => l.key === lens)!.inputs.find((x) => x.key === key)!;

  test("alt breadth: share beating BTC and share with funding above neutral (exactly neutral is not hot)", () => {
    expect(input("rotation", "alts_beating_btc").value).toBeCloseTo((4 / 6) * 100, 2);
    expect(input("rotation", "alts_funding_hot").value).toBeCloseTo(50, 6);
    expect(v.compass.lenses.find((l) => l.key === "rotation")!.score).toBeCloseTo(((4 / 6) * 100 + 50) / 2, 1);
  });

  test("funding APR is the 7d mean of hourly rates × 8760, in percent", () => {
    expect(input("derivatives", "funding_apr").value).toBeCloseTo(0.0000125 * 8760 * 100, 6);
    expect(input("derivatives", "hl_premium").value).toBeCloseTo(0.01, 6);
  });
});
