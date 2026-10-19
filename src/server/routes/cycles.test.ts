import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { CycleCoin, DailyBar } from "../../shared/cycles.js";
import { cyclesRoute, loadHistory, type CyclesDeps, type CyclesResponse } from "./cycles.js";

const DAY = 86_400_000;
const START = Date.UTC(2011, 7, 18);
const ETH_START = Date.UTC(2015, 7, 8);
/** Bitstamp lists ETH/USD from here; nothing older comes back. */
const ETH_BITSTAMP = Date.UTC(2017, 7, 17);
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
  const base: CyclesDeps = {
    now: () => NOW,
    hasDb: () => true,
    ensure: async (coin) => void calls.push(`ensure:${coin}`),
    stored: async (coin) => (calls.push(`stored:${coin}`), series(coin === "BTC" ? START : Date.UTC(2023, 0, 1), NOW - DAY, "hl")),
    livePage: async (coin: CycleCoin, before) => {
      calls.push(`live:${coin}:${before}`);
      // Bitstamp pages are whole UTC days with open time <= before.
      const end = Math.floor(before / DAY) * DAY + DAY;
      const floor = coin === "BTC" ? START : ETH_BITSTAMP;
      return end <= floor ? [] : series(Math.max(floor, end - 1000 * DAY), end, "bitstamp");
    },
    seed: async (coin, from, to) => {
      calls.push(`seed:${coin}`);
      return series(from, to, "coinmetrics");
    },
  };
  return { ...base, ...over, calls };
}

const app = (d: CyclesDeps) => new Hono().route("/cycles", cyclesRoute(d));

describe("loadHistory", () => {
  test("uses stored candles alone when they reach back to 2011", async () => {
    const d = deps();
    const h = await loadHistory("BTC", d);
    expect(d.calls).toEqual(["ensure:BTC", "stored:BTC"]);
    expect(h[0]!.t).toBe(START);
  });

  test("fills below shallow storage from Bitstamp; stored bars win on overlap", async () => {
    const from = Date.UTC(2020, 7, 19);
    const d = deps({ stored: async () => series(from, NOW - DAY, "hl") });
    const h = await loadHistory("BTC", d);
    expect(h[0]!.t).toBe(START);
    expect(h.find((b) => b.t === from)!.src).toBe("hl");
    expect(h.find((b) => b.t === from - DAY)!.src).toBe("bitstamp");
    expect(new Set(h.map((b) => b.t)).size).toBe(h.length);
  });

  test("without a DB it pages Bitstamp from now", async () => {
    const d = deps({ hasDb: () => false });
    const h = await loadHistory("BTC", d);
    expect(d.calls[0]).toBe(`live:BTC:${NOW - 1}`);
    expect(d.calls.some((c) => c.startsWith("ensure"))).toBe(false);
    expect(d.calls).not.toContain("seed:BTC");
    expect(h[0]!.t).toBe(START);
  });

  test("ETH: stored, then Bitstamp to Aug 2017, then Coin Metrics back to 2015", async () => {
    const d = deps();
    const h = await loadHistory("ETH", d);
    expect(d.calls).toContain("seed:ETH");
    expect(h[0]!.t).toBe(ETH_START);
    const src = (t: number) => h.find((b) => b.t === t)!.src;
    expect(src(ETH_BITSTAMP - DAY)).toBe("coinmetrics");
    expect(src(ETH_BITSTAMP)).toBe("bitstamp");
    expect(src(Date.UTC(2023, 0, 1))).toBe("hl");
    expect(new Set(h.map((b) => b.t)).size).toBe(h.length);
  });

  test("a failing seed leaves the venue history", async () => {
    const d = deps({ seed: async () => Promise.reject(new Error("cm down")) });
    const h = await loadHistory("ETH", d);
    expect(h[0]!.t).toBe(ETH_BITSTAMP);
  });
});

describe("GET /cycles", () => {
  test("400s on a bad tf or coin", async () => {
    expect((await app(deps()).request("/cycles?tf=4h")).status).toBe(400);
    expect((await app(deps()).request("/cycles?coin=SOL")).status).toBe(400);
  });

  test("serves bars, halvings, forecast and analogs; weekly is resampled", async () => {
    const d = deps();
    const daily = (await (await app(d).request("/cycles")).json()) as CyclesResponse;
    expect(daily.coin).toBe("BTC");
    expect(daily.tf).toBe("1d");
    expect(daily.bars.length).toBeGreaterThan(5000);
    expect(daily.halvings).toHaveLength(4);
    expect(daily.forecasts.breakout.kind).toBe("breakout");
    expect(daily.forecasts.euphoria.kind).toBe("euphoria");
    expect(daily.forecasts.breakout.episodes.length).toBeGreaterThanOrEqual(2);
    expect(daily.analogs.length).toBe(daily.forecasts.breakout.episodes.length);
    expect(daily.sources).toEqual({ hl: daily.bars.length });

    const weekly = (await (await app(d).request("/cycles?tf=1w")).json()) as CyclesResponse;
    expect(weekly.bars.length).toBeLessThan(daily.bars.length / 6);
    expect(weekly.forecasts).toEqual(daily.forecasts);
  });

  test("caches per coin and timeframe", async () => {
    const d = deps();
    const a = app(d);
    await a.request("/cycles");
    await a.request("/cycles");
    const eth = (await (await a.request("/cycles?coin=ETH")).json()) as CyclesResponse;
    expect(eth.coin).toBe("ETH");
    expect(d.calls.filter((c) => c === "stored:BTC")).toHaveLength(1);
    expect(d.calls.filter((c) => c === "stored:ETH")).toHaveLength(1);
  });

  test("503s when no history can be loaded", async () => {
    const d = deps({ hasDb: () => false, livePage: async () => [], seed: async () => [] });
    expect((await app(d).request("/cycles")).status).toBe(503);
  });
});
