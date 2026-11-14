import { describe, expect, test } from "bun:test";
import type { Candle } from "../../shared/types.js";
import { clearsMinRr, convictionOfRr, extremeLevels, extremesMinRr, priceExtreme, tradeHints } from "./pricing.js";

const HOUR = 3_600_000;
/**
 * `n` flat 1h bars around 100 (high 101, low 99: true range 2, so the ATR is 2), with a 90 low 20 bars back and a
 * 110 high 22 bars back: both inside the last 24 h and the 72 h range, both outside the ATR's last 14 bars.
 */
function bars(n = 80, base = 100, low = 90, high = 110): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const back = n - i;
    return { t: i * HOUR, T: (i + 1) * HOUR - 1, o: base, c: base, h: back === 22 ? high : base + 1, l: back === 20 ? low : base - 1, v: 1 };
  });
}

describe("extremeLevels", () => {
  test("ATR, the last 24 h's extremes (the mark included) and the 72 h range before the current bar", () => {
    expect(extremeLevels(bars(), 95)).toEqual({ atr1h: 2, hi24h: 110, lo24h: 90, range72h: { lo: 90, hi: 110, mid: 100 } });
    expect(extremeLevels(bars(), 120)!.hi24h).toBe(120);
    expect(extremeLevels(bars(40), 95)!.range72h).toBeNull();
    expect(extremeLevels(bars(10), 95)).toBeNull();
  });
});

describe("priceExtreme", () => {
  const flush = { kind: "oi_flush" as const, fadeSide: "long" as const, direction: "long" as const, bars: bars() };

  test("oi_flush long is a flush reversion: stop under the 24h low by half an ATR, target half the day's range back", () => {
    expect(priceExtreme({ ...flush, entry: 92, killPx: 91 })).toEqual({
      priced: true, setup: "flush_reversion", entry: 92, stop: 89, target: 100, zone: 90, rr: 2.67, structuralStop: 89,
      levels: { atr1h: 2, hi24h: 110, lo24h: 90, range72h: { lo: 90, hi: 110, mid: 100 } },
    });
  });

  test("the stop is the farther of the structure and the kill", () => {
    expect(priceExtreme({ ...flush, entry: 92, killPx: 88 })).toMatchObject({ stop: 88, rr: 2 });
  });

  test("a stop closer than 0.75 ATR is widened, so it cannot inflate the R:R", () => {
    expect(priceExtreme({ ...flush, entry: 90.2, killPx: 90 })).toMatchObject({ stop: 88.7, rr: 6.53 });
  });

  test("oi_flush short is a squeeze exhaustion off the 24h high", () => {
    expect(priceExtreme({ ...flush, fadeSide: "short", direction: "short", entry: 108, killPx: 109 })).toMatchObject({ setup: "squeeze_exhaustion", stop: 111, target: 100, zone: 110, rr: 2.67 });
  });

  test("price_dislocation fades the extension back to the 72h median", () => {
    expect(priceExtreme({ kind: "price_dislocation", fadeSide: "short", direction: "short", entry: 108, killPx: 109, bars: bars() })).toMatchObject({ setup: "fade_extension", stop: 111, target: 100, zone: 110, rr: 2.67 });
  });

  test("crowded_asymmetry long waits on a short squeeze: stop under the 72h low, target the 72h high", () => {
    expect(priceExtreme({ kind: "crowded_asymmetry", fadeSide: "long", direction: "long", entry: 95, killPx: 93, bars: bars() })).toMatchObject({ setup: "short_squeeze_loading", stop: 89.5, target: 110, zone: 90, rr: 2.73 });
    expect(priceExtreme({ kind: "crowded_asymmetry", fadeSide: "short", direction: "short", entry: 105, killPx: 107, bars: bars() })).toMatchObject({ setup: "long_squeeze_loading", stop: 110.5, target: 90 });
  });

  test("unpriced: against the fade side, a target already behind the mark, too few candles", () => {
    expect(priceExtreme({ ...flush, direction: "short", entry: 92, killPx: 95 })).toEqual({ priced: false, reason: "a short against the event's long fade has no template" });
    expect(priceExtreme({ ...flush, entry: 101, killPx: 95 })).toMatchObject({ priced: false, reason: expect.stringContaining("already behind the mark") });
    expect(priceExtreme({ ...flush, entry: 92, killPx: 91, bars: bars(10) })).toEqual({ priced: false, reason: "under 15 h of 1h candles" });
    expect(priceExtreme({ kind: "price_dislocation", fadeSide: "short", direction: "short", entry: 108, killPx: 109, bars: bars(40) })).toEqual({ priced: false, reason: "under 48 h of candles for the 72 h range" });
  });
});

describe("floor, conviction and the desk's hints", () => {
  test("the R:R floor is compared at one decimal: 1.98 clears 2, 1.94 does not", () => {
    expect(clearsMinRr(1.98, 2)).toBe(true);
    expect(clearsMinRr(1.94, 2)).toBe(false);
    expect(clearsMinRr(2.5, 2.5)).toBe(true);
  });

  test("EXTREMES_MIN_RR, default 2", () => {
    expect(extremesMinRr({})).toBe(2);
    expect(extremesMinRr({ EXTREMES_MIN_RR: "2.5" })).toBe(2.5);
    expect(extremesMinRr({ EXTREMES_MIN_RR: "nope" })).toBe(2);
    expect(extremesMinRr({ EXTREMES_MIN_RR: "0" })).toBe(2);
  });

  test("conviction from the R:R", () => {
    expect([1.98, 2.49, 2.5, 3.49, 3.5].map(convictionOfRr)).toEqual(["low", "low", "medium", "medium", "high"]);
  });

  test("tags carry the conviction and leverage back to the desk; anything else is ignored", () => {
    expect(tradeHints(["extreme", "oi_flush", "conviction:high", "leverage:5"])).toEqual({ confidence: "high", leverage: 5 });
    expect(tradeHints(["conviction:huge", "leverage:11", "leverage:2.5"])).toEqual({});
  });
});
