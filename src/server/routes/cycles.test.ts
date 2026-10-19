import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { DailyBar } from "../../shared/cycles.js";
import { cyclesRoute, loadHistory, type CyclesDeps, type CyclesResponse } from "./cycles.js";

const DAY = 86_400_000;
const START = Date.UTC(2011, 7, 18);
const NOW = Date.UTC(2026, 9, 19, 12);

// A smooth four-year boom/bust so the model has real phases to find.
function bar(t: number, src: string): DailyBar {
  const y = (t - START) / (365.25 * DAY);
  const c = 10 * Math.exp(0.9 * y + 1.6 * Math.sin((2 * Math.PI * y) / 4));
  return { t, o: c, h: c, l: c, c, v: 1, src };
}
const series = (from: number, to: number, src: string) => {
  const out: DailyBar[] = [];
  for (let t = from; t < to; t += DAY) out.push(bar(t, src));
  return out;
};

function deps(over: Partial<CyclesDeps> = {}): CyclesDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    now: () => NOW,
    hasDb: () => true,
    ensure: async () => void calls.push("ensure"),
    stored: async () => (calls.push("stored"), series(START, NOW - DAY, "hl")),
    livePage: async (before) => {
      calls.push(`live:${before}`);
      // Bitstamp pages are whole UTC days with open time <= before.
      const end = Math.floor(before / DAY) * DAY + DAY;
      return series(Math.max(START, end - 1000 * DAY), end, "bitstamp");
    },
    ...over,
  };
}

const app = (d: CyclesDeps) => new Hono().route("/cycles", cyclesRoute(d));

describe("loadHistory", () => {
  test("uses stored candles alone when they reach back to 2011", async () => {
    const d = deps();
    const h = await loadHistory(d);
    expect(d.calls).toEqual(["ensure", "stored"]);
    expect(h[0]!.t).toBe(START);
  });

  test("fills below shallow storage from Bitstamp; stored bars win on overlap", async () => {
    const from = Date.UTC(2020, 7, 19);
    const d = deps({ stored: async () => series(from, NOW - DAY, "hl") });
    const h = await loadHistory(d);
    expect(h[0]!.t).toBe(START);
    expect(h.find((b) => b.t === from)!.src).toBe("hl");
    expect(h.find((b) => b.t === from - DAY)!.src).toBe("bitstamp");
    expect(new Set(h.map((b) => b.t)).size).toBe(h.length);
  });

  test("without a DB it pages Bitstamp from now", async () => {
    const d = deps({ hasDb: () => false });
    const h = await loadHistory(d);
    expect(d.calls[0]).toBe(`live:${NOW - 1}`);
    expect(d.calls).not.toContain("ensure");
    expect(h[0]!.t).toBe(START);
  });
});

describe("GET /cycles", () => {
  test("400s on a bad tf", async () => {
    expect((await app(deps()).request("/cycles?tf=4h")).status).toBe(400);
  });

  test("serves bars, halvings, forecast and analogs; weekly is resampled", async () => {
    const d = deps();
    const daily = (await (await app(d).request("/cycles")).json()) as CyclesResponse;
    expect(daily.tf).toBe("1d");
    expect(daily.bars.length).toBeGreaterThan(5000);
    expect(daily.halvings).toHaveLength(4);
    expect(daily.forecast.episodes.length).toBeGreaterThanOrEqual(2);
    expect(daily.analogs.length).toBe(daily.forecast.episodes.length);
    expect(daily.sources).toEqual({ hl: daily.bars.length });

    const weekly = (await (await app(d).request("/cycles?tf=1w")).json()) as CyclesResponse;
    expect(weekly.bars.length).toBeLessThan(daily.bars.length / 6);
    expect(weekly.forecast).toEqual(daily.forecast);
  });

  test("caches per timeframe", async () => {
    const d = deps();
    const a = app(d);
    await a.request("/cycles");
    await a.request("/cycles");
    expect(d.calls.filter((c) => c === "stored")).toHaveLength(1);
  });

  test("503s when no history can be loaded", async () => {
    const d = deps({ hasDb: () => false, livePage: async () => [] });
    expect((await app(d).request("/cycles")).status).toBe(503);
  });
});
