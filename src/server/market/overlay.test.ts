import { describe, expect, test } from "bun:test";
import type { Bar } from "./candleSync.js";
import { joinOverlays } from "./overlay.js";

const M = 60_000;
const H = 60 * M;
const T0 = Date.UTC(2024, 0, 1);
const bar = (t: number): Bar => ({ t, o: 1, h: 1, l: 1, c: 1, v: 1, src: "hl" });

// Settlements at the top of each hour; rate = hour index, premium = hour / 10.
const funding = Array.from({ length: 10 }, (_, i) => ({ t: T0 + i * H, rate: i, premium: i / 10 }));

describe("joinOverlays", () => {
  test("hourly bars own the settlement at their close", () => {
    const out = joinOverlays([bar(T0), bar(T0 + H), bar(T0 + 2 * H)], "1h", funding, []);
    expect(out.map((b) => b.f)).toEqual([1, 2, 3]);
    expect(out[0]!.p).toBeCloseTo(0.1);
  });

  test("4h bars average their four settlements", () => {
    const out = joinOverlays([bar(T0), bar(T0 + 4 * H)], "4h", funding, []);
    expect(out[0]!.f).toBe((1 + 2 + 3 + 4) / 4);
    expect(out[1]!.f).toBe((5 + 6 + 7 + 8) / 4);
  });

  test("sub-hour bars take the settlement of the hour they sit in", () => {
    const out = joinOverlays([bar(T0), bar(T0 + 15 * M), bar(T0 + 45 * M), bar(T0 + H)], "15m", funding, []);
    expect(out.map((b) => b.f)).toEqual([1, 1, 1, 2]);
  });

  test("bars after the last settlement have no funding", () => {
    const out = joinOverlays([bar(T0 + 9 * H)], "1h", funding, []);
    expect(out[0]!.f).toBeNull();
  });

  test("OI is the last snapshot inside the bar, with a 30-minute look-back for short bars", () => {
    const oi = [
      { t: T0 + 10 * M, v: 100 },
      { t: T0 + 25 * M, v: 110 },
      { t: T0 + 70 * M, v: 120 },
    ];
    const hourly = joinOverlays([bar(T0), bar(T0 + H)], "1h", [], oi);
    expect(hourly.map((b) => b.oi)).toEqual([110, 120]);

    const fives = joinOverlays([bar(T0 + 30 * M), bar(T0 + 50 * M), bar(T0 + 55 * M)], "5m", [], oi);
    // 30m bar ends 35m: 25m snapshot is inside the look-back. 55m bar ends 60m: 25m is 35m stale.
    expect(fives.map((b) => b.oi)).toEqual([110, 110, null]);
  });
});
