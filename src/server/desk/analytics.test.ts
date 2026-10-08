import { describe, expect, test } from "bun:test";
import { classifyRegime, marketBreadth, rallyDiagnostics, zScore } from "./analytics.js";
import { ctx, hourly } from "./testkit.js";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-10-05T12:00:00Z");

/** 72 flat hours then 72 hours rising `pct` in total, with a small wiggle so vol is non-zero. */
function rally(pct: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < 144; i++) {
    const trend = i < 72 ? 0 : (pct / 100) * ((i - 71) / 72);
    out.push(100 * (1 + trend) * (1 + 0.003 * Math.sin(i * 1.7)));
  }
  return out;
}

function funding(hours: number, rateAt: (i: number, recent: boolean) => number) {
  return Array.from({ length: hours }, (_, i) => {
    const t = NOW - (hours - i) * HOUR;
    const recent = t >= NOW - 72 * HOUR;
    return { t, rate: rateAt(i, recent), premium: recent ? 0.0004 : 0.0001 * Math.sin(i) };
  });
}

describe("classifyRegime", () => {
  test.each([
    [5, 6, 0, 10, "new_longs"],
    [5, 6, 2, 10, "crowded_long_build"],
    [5, 6, 0, 40, "crowded_long_build"],
    [5, -6, 0, 10, "short_covering"],
    [5, 1, 0, 10, "spot_led_rally"],
    [-5, 6, -2, -20, "crowded_short_build"],
    [-5, 6, 0, 0, "new_shorts"],
    [-5, -6, 0, 0, "long_liquidation"],
    [-5, 0, 0, 0, "spot_led_selloff"],
    [0.5, 20, 3, 80, "range"],
  ] as const)("price %p%% oi %p%% fz %p apr %p → %s", (px, oi, fz, apr, want) => {
    expect(classifyRegime(px, oi, fz, apr)).toBe(want);
  });

  test("falls back to funding alone without OI", () => {
    expect(classifyRegime(5, null, 2, 10)).toBe("crowded_long_build");
    expect(classifyRegime(5, null, 0, 10)).toBe("spot_led_rally");
  });
});

describe("zScore", () => {
  test("needs a base of at least 24 points with spread", () => {
    expect(zScore(1, [1, 2, 3])).toBeNull();
    expect(zScore(1, Array(30).fill(1))).toBeNull();
    const base = Array.from({ length: 30 }, (_, i) => (i % 2 ? 1 : -1));
    expect(zScore(2, base)).toBeCloseTo(2, 5);
  });
});

describe("rallyDiagnostics", () => {
  test("a rally on falling OI, hot funding and thinning volume reads as short covering with elevated trap risk", () => {
    const candles = hourly(rally(10), NOW, (i) => (i < 72 ? 200 : 100));
    const oi = Array.from({ length: 80 }, (_, i) => ({ t: NOW - (80 - i) * HOUR, v: i < 8 ? 1e9 : 1e9 * (1 - 0.1 * ((i - 7) / 72)) }));
    const f = funding(30 * 24 + 72, (i, recent) => (recent ? 0.00006 : 0.00001 * Math.sin(i)));
    const d = rallyDiagnostics({ coin: "ETH", windowHours: 72, candles, funding: f, oi, now: NOW });
    expect(d.direction).toBe("up");
    expect(d.priceChangePct).toBeGreaterThan(8);
    expect(d.oiChangePct).toBeLessThan(-8);
    expect(d.regime).toBe("short_covering");
    // Dollar volume: half the coins at ~5% higher prices.
    expect(d.volumeRatio).toBeGreaterThan(0.45);
    expect(d.volumeRatio).toBeLessThan(0.6);
    const pts = Object.fromEntries(d.components.map((c) => [c.name, c.points]));
    expect(pts["OI vs price"]).toBe(20);
    expect(pts["volume trend"]).toBeGreaterThan(12);
    expect(pts["funding heat"]).toBe(25);
    expect(d.trapScore).toBeGreaterThanOrEqual(55);
    expect(d.label).toBe("elevated trap risk");
  });

  test("a rally on flat OI, neutral funding and rising volume reads as spot-led with low trap risk", () => {
    const candles = hourly(rally(6), NOW, (i) => (i < 72 ? 100 : 200));
    const oi = Array.from({ length: 80 }, (_, i) => ({ t: NOW - (80 - i) * HOUR, v: 1e9 * (1 + 0.001 * Math.sin(i)) }));
    const f = funding(30 * 24 + 72, (i) => 0.00001 * Math.sin(i));
    const d = rallyDiagnostics({ coin: "BTC", windowHours: 72, candles, funding: f, oi, now: NOW });
    expect(d.regime).toBe("spot_led_rally");
    expect(d.volumeRatio).toBeGreaterThan(1.9);
    expect(d.volumeRatio).toBeLessThan(2.2);
    expect(d.trapScore).toBeLessThan(30);
    expect(d.label).toBe("low trap risk");
  });

  test("OI history that starts after the window opens is not used", () => {
    const candles = hourly(rally(6), NOW);
    const oi = [
      { t: NOW - 10 * HOUR, v: 1e9 },
      { t: NOW - HOUR, v: 1.2e9 },
    ];
    const d = rallyDiagnostics({ coin: "BTC", windowHours: 72, candles, funding: [], oi, now: NOW });
    expect(d.oiChangePct).toBeNull();
    expect(d.notes.join(" ")).toContain("OI change unknown");
  });

  test("a flat window scores zero", () => {
    const flat = Array.from({ length: 144 }, (_, i) => 100 * (1 + 0.002 * Math.sin(i)));
    const d = rallyDiagnostics({ coin: "BTC", windowHours: 72, candles: hourly(flat, NOW), funding: [], oi: [], now: NOW });
    expect(d.direction).toBe("flat");
    expect(d.trapScore).toBe(0);
    expect(d.label).toBe("no move");
  });

  test("throws without candles for the window", () => {
    expect(() => rallyDiagnostics({ coin: "X", windowHours: 72, candles: [], funding: [], oi: [], now: NOW })).toThrow();
  });
});

describe("marketBreadth", () => {
  test("advancing share, BTC lead and OI-weighted funding over the top by OI", () => {
    const ctxs = [
      ctx("BTC", 100_000, { dayChange: 0.05, openInterest: 100, funding: 0.0001 }),
      ctx("ETH", 4_000, { dayChange: 0.01, openInterest: 1000, funding: 0 }),
      ctx("SOL", 200, { dayChange: -0.02, openInterest: 10_000, funding: -0.0001 }),
      ctx("DEAD", 1, { dayChange: 0.5, isDelisted: true }),
    ];
    const b = marketBreadth(ctxs, 10);
    expect(b.sample).toBe(3);
    expect(b.advancingPct).toBeCloseTo(66.7, 1);
    expect(b.medianDayChangePct).toBe(1);
    expect(b.btcLeadPct).toBe(4);
    // OI notionals: BTC 10M, ETH 4M, SOL 2M → weighted funding (10M*1e-4 − 2M*1e-4)/16M = 5e-5/h
    expect(b.oiWeightedFundingApr).toBeCloseTo(43.8, 1);
    expect(b.hotFunding[0]!.coin).toBe("BTC");
    expect(b.coldFunding[0]!.coin).toBe("SOL");
  });
});
