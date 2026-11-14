import { describe, expect, test } from "bun:test";
import type { ExtremeEvent } from "../../shared/extremes.js";
import type { RingPoint } from "../platform/features.js";
import { EXTREME_MIN_HISTORY_MS } from "./detect.js";
import { gradeEvent, replayExtremes, returnStats } from "./replay.js";

const MIN = 60_000;
const BAR = 15 * MIN;
const HOUR = 60 * MIN;
const T0 = Date.UTC(2026, 8, 1);

/** Deterministic zig-zag noise (±0.25% a bar, period 7) plus `drift(i)` log return per bar; NaN OI like a candle stream. */
function stream(n: number, drift: (i: number) => number, oi = false): RingPoint[] {
  let mark = 100;
  return Array.from({ length: n }, (_, i) => {
    mark *= Math.exp(0.0025 * Math.sin(i * 2.1) * (1 + (i % 7) / 7) + drift(i));
    return { ts: T0 + i * BAR, mark, oiUsd: oi ? 1e8 : NaN, funding: 1e-5, dayNtlVlm: 1e8 };
  });
}

const ev = (o: Partial<ExtremeEvent>): ExtremeEvent => ({
  key: "price_dislocation|SOL|long", kind: "price_dislocation", coin: "SOL", side: "long", ts: new Date(T0).toISOString(), window: "24h",
  mark: 100, severity: 5, facts: {}, line: "SOL", ...o,
});

describe("gradeEvent", () => {
  test("fade-side return at exactly ts + horizon, absolute and vs BTC; ungraded past the stream", () => {
    const pts = (marks: number[]) => marks.map((mark, i) => ({ ts: T0 + i * HOUR, mark, oiUsd: NaN, funding: 0, dayNtlVlm: 0 }));
    const streams = new Map([["SOL", pts([100, 104, 110])], ["BTC", pts([50, 51, 50])]]);
    const long = gradeEvent(ev({}), streams, HOUR)!;
    expect(long.abs).toBeCloseTo(0.04, 10);
    expect(long.vsBtc!).toBeCloseTo(0.04 - 0.02, 10);
    const short = gradeEvent(ev({ side: "short", key: "price_dislocation|SOL|short" }), streams, 2 * HOUR)!;
    expect(short.abs).toBeCloseTo(-0.1, 10);
    expect(short.vsBtc!).toBeCloseTo(-0.1, 10);
    expect(gradeEvent(ev({ coin: "BTC", mark: 50 }), streams, HOUR)!.vsBtc).toBeNull();
    expect(gradeEvent(ev({}), streams, 3 * HOUR)).toBeNull();
    expect(gradeEvent(ev({}), streams, 30 * MIN)).toBeNull(); // no point exactly there
  });

  test("returnStats", () => {
    expect(returnStats([])).toEqual({ n: 0, hitRate: null, median: null, mean: null });
    expect(returnStats([0.02, -0.01, 0.05])).toEqual({ n: 3, hitRate: 2 / 3, median: 0.02, mean: 0.02 });
  });
});

describe("replayExtremes", () => {
  // 20 days of history, then a 50% slide over 2 days: the detector keeps firing every step of the slide.
  const n = 22 * 96;
  const slide = (i: number) => (i >= 20 * 96 ? Math.log(0.5) / (2 * 96) : 0);
  const streams = new Map([["BTC", stream(n, slide)]]);
  const grid = Array.from({ length: 2 * 96 }, (_, k) => T0 + EXTREME_MIN_HISTORY_MS + 6 * 96 * BAR + k * BAR).filter((t) => t <= T0 + (n - 1) * BAR);

  test("per-key cooldown: one event per key per cooldown, re-fires once it lapses", () => {
    const day = replayExtremes({ streams, grid, cooldownMs: 24 * HOUR });
    const pd = day.events.filter((e) => e.kind === "price_dislocation");
    expect(pd.length).toBe(2);
    expect(Date.parse(pd[1]!.ts) - Date.parse(pd[0]!.ts)).toBeGreaterThanOrEqual(24 * HOUR);
    expect(pd.every((e) => e.side === "long")).toBe(true);
    const short = replayExtremes({ streams, grid, cooldownMs: 6 * HOUR }).events.filter((e) => e.kind === "price_dislocation");
    expect(short.length).toBeGreaterThan(pd.length);
    for (let i = 1; i < short.length; i++) expect(Date.parse(short[i]!.ts) - Date.parse(short[i - 1]!.ts)).toBeGreaterThanOrEqual(6 * HOUR);
  });

  test("rows: OI kinds not evaluable without OI (never 0 events), grading counts only events with an exit", () => {
    const r = replayExtremes({ streams, grid, cooldownMs: 24 * HOUR, horizonsMs: [4 * HOUR, 72 * HOUR] });
    const pd = r.rows.find((x) => x.kind === "price_dislocation")!;
    expect(pd.evaluable).toBe(true);
    expect(pd.events).toBe(2);
    expect(pd.long).toBe(2);
    expect(pd.perWeek).toBeCloseTo(2 / r.weeks, 10);
    expect(pd.horizons.map((h) => h.horizon)).toEqual(["4h", "72h"]);
    // the slide continues after the first event, so the long fade loses at 4 h; 72 h runs past the stream's end
    const h4 = pd.horizons[0]!;
    expect(h4.abs.n).toBe(2);
    expect(h4.abs.hitRate).toBe(0);
    expect(h4.vsBtc.n).toBe(0); // BTC vs BTC is not graded
    expect(pd.horizons[1]!.abs.n).toBe(0);
    for (const kind of ["oi_flush", "crowded_asymmetry"] as const) {
      const row = r.rows.find((x) => x.kind === kind)!;
      expect(row.evaluable).toBe(false);
      expect(row.reason).toMatch(/OI/);
      expect(row.perWeek).toBeNull();
    }
    const withOi = replayExtremes({ streams: new Map([["BTC", stream(n, slide, true)]]), grid });
    expect(withOi.rows.every((x) => x.evaluable)).toBe(true);
  });
});
