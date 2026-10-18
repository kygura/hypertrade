import { describe, expect, test } from "bun:test";
import type { Candle } from "../../shared/types.js";
import { htfFeatures, htfRefreshReason, realisedVol, sma } from "./htf.js";
import type { HtfView } from "./schema.js";

const DAY = 86_400_000;
const T0 = Date.UTC(2025, 0, 1);

/** One candle per step from a close series; high/low ±1% around the close. */
function candles(closes: number[], stepMs = DAY, t0 = T0): Candle[] {
  return closes.map((c, i) => ({ t: t0 + i * stepMs, T: t0 + (i + 1) * stepMs - 1, o: c, h: c * 1.01, l: c * 0.99, c, v: 1 }));
}
const ramp = (n: number, from: number, step: number) => Array.from({ length: n }, (_, i) => from + i * step);

describe("htf features", () => {
  test("sma uses the last n closes, offset by `back`", () => {
    const cs = candles([1, 2, 3, 4, 5]);
    expect(sma(cs, 2)).toBe(4.5);
    expect(sma(cs, 2, 1)).toBe(3.5);
    expect(sma(cs, 6)).toBeNull();
  });

  test("uptrend: close above rising 20W and 50W, 52w range and 4w return", () => {
    const daily = candles(ramp(400, 100, 1)); // 100 → 499
    const weekly = candles(ramp(60, 100, 7), 7 * DAY);
    const f = htfFeatures(daily, weekly)!;
    expect(f.close).toBe(499);
    expect(f.trend).toBe("up");
    expect(f.sma200d).toBe(399.5); // mean of 300..499
    expect(f.vs200dPct).toBeCloseTo(((499 - 399.5) / 399.5) * 100, 1);
    expect(f.high52w).toBeCloseTo(499 * 1.01, 6);
    expect(f.low52w).toBeCloseTo(135 * 0.99, 6); // last 365 closes start at 135
    expect(f.ret4wPct).toBeCloseTo(((499 - 471) / 471) * 100, 1);
    expect(f.fromHighPct).toBeLessThan(0);
    expect(f.sma20wSlope4wPct).toBeGreaterThan(0);
  });

  test("downtrend and range labels", () => {
    const down = htfFeatures(candles(ramp(400, 500, -1)), candles(ramp(60, 600, -7), 7 * DAY))!;
    expect(down.trend).toBe("down");
    // Long rise then a drop below the 20W average while it still rises: range, not down.
    const weekly = candles([...ramp(59, 100, 5), 300], 7 * DAY);
    expect(htfFeatures(candles([300]), weekly)!.trend).toBe("range");
  });

  test("not enough history → nulls, never NaN", () => {
    const f = htfFeatures(candles([10, 11, 12]), candles([10, 11], 7 * DAY))!;
    expect(f).toMatchObject({ sma20w: null, sma50w: null, sma200d: null, high52w: null, rv30Pct: null, ret4wPct: null, trend: null });
    expect(htfFeatures([], [])).toBeNull();
  });

  test("realised vol: flat series is 0, alternating ±1% is about 19% annualised", () => {
    expect(realisedVol(candles(Array(40).fill(100)))).toBe(0);
    const alt = Array.from({ length: 41 }, (_, i) => (i % 2 ? 101 : 100));
    expect(realisedVol(candles(alt))!).toBeCloseTo(19.1, 0);
  });
});

describe("htf refresh", () => {
  const now = new Date("2026-10-18T12:00:00Z");
  const view = { generated_at: "2026-10-15T00:00:00Z", hl_cycles_state: "mild_risk_on" } as HtfView;
  test("missing, old, regime changed, forced; current view → null", () => {
    expect(htfRefreshReason(null, "x", now)).toBe("no HTF view yet");
    expect(htfRefreshReason({ ...view, generated_at: "2026-10-10T00:00:00Z" }, "mild_risk_on", now)).toContain("8 days old");
    expect(htfRefreshReason(view, "mild_risk_off", now)).toContain("mild_risk_on → mild_risk_off");
    expect(htfRefreshReason(view, "mild_risk_on", now, true)).toContain("forced");
    expect(htfRefreshReason(view, "mild_risk_on", now)).toBeNull();
    expect(htfRefreshReason(view, null, now)).toBeNull(); // hl-cycles down: no evidence of a change
  });
});
