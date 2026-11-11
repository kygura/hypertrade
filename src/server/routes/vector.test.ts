import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { DailyBar } from "../../shared/cycles.js";
import type { Row } from "../../shared/vectorCompass.js";
import type { Loader, SourceData } from "../vector/sources.js";
import { FAIL_RETRY_MS, SOURCE_TTL_MS, vectorRoute, type VectorDeps, type VectorResponse } from "./vector.js";

const DAY = 86_400_000;
const T0 = Date.UTC(2023, 0, 1);
const N = 800;
const NOW = T0 + N * DAY + 3_600_000;

// A steady uptrend with a wobble, so momentum, levels and the regime are all defined at the end.
const bars: DailyBar[] = Array.from({ length: N }, (_, i) => {
  const c = 20_000 * 1.002 ** i * (1 + 0.02 * Math.sin(i / 7));
  return { t: T0 + i * DAY, o: c, h: c, l: c, c, v: 1, src: "fixture" };
});
const rows = (f: (c: number, i: number) => number): Row[] => bars.map((b, i) => ({ t: b.t, v: f(b.c, i) }));

const DATA: Record<string, SourceData> = {
  "btc-price": { daily: bars },
  bgeometrics: {
    series: {
      "sth-realized-price": rows((c) => c * 0.9),
      "true-market-mean": rows((c) => c * 0.8),
      "sth-sopr": rows(() => 1.02),
      "etf-flow-btc": rows(() => 10),
    },
  },
  defillama: { series: { totalStablecoinMcapUSD: rows((_, i) => 1e11 + i * 1e8) } },
  coinmetrics: { series: { RealizedCapUSD: rows((_, i) => 1e11 + i * 1e8), RealizedPriceUSD: rows((c) => c * 0.5) } },
  fred: { series: { DGS10: rows(() => 4.1) }, error: "fred: SP500: HTTP 500" },
};

function deps(over: Partial<Record<string, Loader>> = {}) {
  let now = NOW;
  const calls: Record<string, number> = {};
  const sources: Record<string, Loader> = {};
  for (const name of Object.keys(DATA)) {
    sources[name] = async (t) => {
      calls[name] = (calls[name] ?? 0) + 1;
      const o = over[name];
      return o ? o(t) : DATA[name]!;
    };
  }
  const d: VectorDeps = { now: () => now, sources: () => sources };
  return { d, calls, advance: (ms: number) => (now += ms) };
}

const get = async (app: Hono) => {
  const res = await app.request("/vector");
  return { status: res.status, body: (await res.json()) as VectorResponse };
};
const appOf = (d: VectorDeps) => new Hono().route("/vector", vectorRoute(d));
const down: Loader = async () => {
  throw new Error("bgeometrics: rate limited; missing sth-realized-price");
};

describe("GET /vector", () => {
  test("assembles the payload and reports every source", async () => {
    const { d } = deps();
    const { status, body } = await get(appOf(d));
    expect(status).toBe(200);
    expect(body.asOf).toBe(bars[N - 1]!.t);
    expect(body.price).toBe(Math.round(bars[N - 1]!.c * 100) / 100);
    expect(body.regime.state).not.toBeNull();
    expect(body.levels.find((l) => l.key === "sth_cost_basis")!.value).not.toBeNull();
    expect(Object.keys(body.sources).sort()).toEqual(["bgeometrics", "btc-price", "coinmetrics", "defillama", "fred"]);
    expect(body.sources.coinmetrics).toEqual({ lastOk: NOW, lastError: null });
    // A partial result is a success that names what is missing.
    expect(body.sources.fred).toEqual({ lastOk: NOW, lastError: "fred: SP500: HTTP 500" });
  });

  test("a failing source nulls only its own inputs and never fails the route", async () => {
    const { d } = deps({ bgeometrics: down });
    const { status, body } = await get(appOf(d));
    expect(status).toBe(200);
    expect(body.sources.bgeometrics).toEqual({ lastOk: null, lastError: "bgeometrics: rate limited; missing sth-realized-price" });
    // Its inputs are null: the cost-basis levels and the regime (which needs them) ...
    expect(body.levels.find((l) => l.key === "sth_cost_basis")!.value).toBeNull();
    expect(body.regime.state).toBeNull();
    expect(body.wocPhase).toBeNull();
    // ... while the other sources' inputs still read.
    expect(body.levels.find((l) => l.key === "realized_price")!.value).not.toBeNull();
    expect(body.regime.momentum).not.toBeNull();
    expect(body.price).not.toBeNull();
  });

  test("no price history: 200 with an all-null payload", async () => {
    const { d } = deps({ "btc-price": async () => Promise.reject(new Error("bitstamp: HTTP 503")) });
    const { status, body } = await get(appOf(d));
    expect(status).toBe(200);
    expect(body.asOf).toBeNull();
    expect(body.price).toBeNull();
    expect(body.history).toEqual([]);
    expect(body.sources["btc-price"]!.lastError).toBe("bitstamp: HTTP 503");
  });

  test("sources are cached for SOURCE_TTL_MS; a failed one retries sooner and keeps its last good data", async () => {
    let fail = false;
    const { d, calls, advance } = deps({ bgeometrics: async (t) => (fail ? down(t) : DATA.bgeometrics!) });
    const app = appOf(d);
    const first = await get(app);
    await get(app);
    expect(calls.coinmetrics).toBe(1);

    fail = true;
    advance(SOURCE_TTL_MS);
    const second = await get(app);
    expect(calls.coinmetrics).toBe(2);
    expect(calls.bgeometrics).toBe(2);
    // The last good bitcoin-data rows still drive the model; lastOk keeps its date.
    expect(second.body.sources.bgeometrics).toEqual({ lastOk: NOW, lastError: "bgeometrics: rate limited; missing sth-realized-price" });
    expect(second.body.regime.state).toBe(first.body.regime.state);

    advance(FAIL_RETRY_MS);
    await get(app);
    expect(calls.coinmetrics).toBe(2); // still fresh
    expect(calls.bgeometrics).toBe(2); // bitcoin-data waits longer than FAIL_RETRY_MS (its quota)
    advance(3 * 60 * 60_000);
    fail = false;
    const third = await get(app);
    expect(calls.bgeometrics).toBe(3);
    expect(third.body.sources.bgeometrics!.lastError).toBeNull();
  });

  test("concurrent requests share one refresh", async () => {
    const { d, calls } = deps();
    const app = appOf(d);
    await Promise.all([get(app), get(app), get(app)]);
    expect(calls.coinmetrics).toBe(1);
  });
});
