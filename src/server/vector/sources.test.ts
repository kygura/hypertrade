import { describe, expect, test } from "bun:test";
import bgSopr from "./fixtures/bg-sth-sopr.json";
import bgSth from "./fixtures/bg-sth-realized-price.json";
import cmPage from "./fixtures/coinmetrics-page.json";
import deribitBook from "./fixtures/deribit-book.json";
import {
  bgLoader,
  BG_METRICS,
  computeOptionsSnapshot,
  createVectorLoaders,
  fetchBGeometrics,
  fetchCoinMetrics,
  memoryVectorStore,
  parseBgSeries,
  parseCoinMetrics,
  skewLoader,
  type VectorSourceIo,
} from "./sources.js";

// Parsers and loaders of the Vector's daily sources (ported from hl-cycles test/vector.test.ts where the
// source is new here). Fixtures are hl-cycles' recorded responses; no test touches the network.

const DAY = 86_400_000;
const D = (s: string) => Date.parse(`${s}T00:00:00Z`);
const jsonRes = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
const fetchOf = (f: (url: string) => Response | Promise<Response>) => (async (url: string | URL | Request) => f(String(url))) as unknown as typeof fetch;

describe("coinmetrics", () => {
  test("parses string decimals, ignores -status fields, derives realized cap and price", () => {
    const s = parseCoinMetrics([cmPage]);
    expect(s.CapMVRVCur![0]!.t).toBe(D("2026-09-28"));
    expect(s.FlowInExNtv).toHaveLength(3);
    const mcap = s.CapMrktCurUSD![0]!.v;
    const mvrv = s.CapMVRVCur![0]!.v;
    expect(s.RealizedCapUSD![0]!.v).toBeCloseTo(mcap / mvrv, 0);
    expect(s.RealizedPriceUSD![0]!.v).toBeCloseTo(mcap / mvrv / s.SplyCur![0]!.v, 6);
  });

  test("one request for every metric; refuses a next_page_url that leaves the API", async () => {
    const urls: string[] = [];
    const ok = await fetchCoinMetrics(fetchOf((u) => (urls.push(u), jsonRes({ data: cmPage.data }))));
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("metrics=CapMrktCurUSD%2CCapMVRVCur");
    expect(ok.HashRate).toHaveLength(3);
    for (const next of ["https://evil.example/x", "https://community-api.coinmetrics.io/v4/timeseries/asset-metrics.evil.example/?a=1"]) {
      await expect(fetchCoinMetrics(fetchOf(() => jsonRes({ data: cmPage.data, next_page_url: next })))).rejects.toThrow();
    }
  });
});

describe("bgeometrics", () => {
  test("parses string and numeric value keys", () => {
    expect(parseBgSeries(bgSth)).toEqual([
      { t: D("2026-09-22"), v: 72763.08 },
      { t: D("2026-09-23"), v: 72797.88 },
      { t: D("2026-09-24"), v: 72875.88 },
    ]);
    expect(parseBgSeries(bgSopr).map((r) => r.v)).toEqual([1.0121, 1.0002, 1.0026]);
  });

  test("drops blank values and rows with ambiguous value keys; rejects a non-array", () => {
    expect(parseBgSeries([{ d: "2026-01-01", unixTs: "1767225600", x: "" }, { d: "2026-01-02", a: 1, b: 2 }])).toEqual([]);
    expect(() => parseBgSeries({ error: "quota" })).toThrow();
  });

  test("429 stops the loop without retry and names the missing metrics", async () => {
    let calls = 0;
    const r = await fetchBGeometrics(
      fetchOf(() => (++calls === 1 ? jsonRes([{ d: "2026-09-22", unixTs: 1790035200, sthRealizedPrice: 1 }]) : jsonRes({}, 429))),
      undefined,
    );
    expect(calls).toBe(2);
    expect(Object.keys(r.series)).toEqual(["sth-realized-price"]);
    expect(r.error).toContain("rate limited; missing true-market-mean");
    expect(r.error).toContain("etf-flow-btc");
  });

  test("stops early when the hourly quota header hits 0", async () => {
    let calls = 0;
    const r = await fetchBGeometrics(
      fetchOf(() => (calls++, jsonRes([{ d: "2026-09-22", unixTs: 1790035200, v: 1 }], 200, { "X-RateLimit-Remaining-Hour": "0" }))),
      undefined,
    );
    expect(calls).toBe(1);
    expect(r.error).toContain("hourly quota exhausted");
  });

  test("the token goes in the query, never into an error", async () => {
    const urls: string[] = [];
    const err = await fetchBGeometrics(
      fetchOf((u) => (urls.push(u), jsonRes({}, 500))),
      "s3cret",
    ).catch((e: Error) => e.message);
    expect(urls[0]).toBe("https://bitcoin-data.com/v1/sth-realized-price?token=s3cret");
    expect(err).not.toContain("s3cret");
  });

  test("loader fetches once per UTC day, then serves what it stored; a failed fetch falls back to stored rows", async () => {
    const store = memoryVectorStore();
    let calls = 0;
    let fail = false;
    const load = bgLoader({
      store,
      fetchFn: fetchOf(() => {
        calls++;
        if (fail) return jsonRes({}, 429);
        return jsonRes([{ d: "2026-09-22", unixTs: 1790035200, value: calls }]);
      }),
    });
    const now = D("2026-09-23") + 3_600_000;
    const first = await load(now);
    expect(calls).toBe(BG_METRICS.length);
    expect(first.error).toBeUndefined();
    expect(first.series!["sth-realized-price"]).toEqual([{ t: D("2026-09-22"), v: 1 }]);

    const sameDay = await load(now + 6 * 3_600_000);
    expect(calls).toBe(BG_METRICS.length);
    expect(sameDay.fetchedAt).toBe(now);

    fail = true;
    const nextDay = await load(now + DAY);
    expect(calls).toBe(BG_METRICS.length + 1);
    expect(nextDay.error).toContain("rate limited");
    expect(nextDay.fetchedAt).toBe(now);
    expect(nextDay.series!["sth-realized-price"]).toHaveLength(1);
  });

  test("loader with nothing stored and a failing API throws", async () => {
    await expect(bgLoader({ store: memoryVectorStore(), fetchFn: fetchOf(() => jsonRes({}, 429)) })(D("2026-09-23"))).rejects.toThrow("rate limited");
  });
});

describe("deribit skew snapshot", () => {
  test("skew and put/call OI from a real book (two expiries bracketing 30d)", () => {
    const snap = computeOptionsSnapshot(deribitBook, deribitBook.usIn / 1000);
    expect(snap.skew25d).toBeCloseTo(1.2085, 3);
    expect(snap.putCallOi).toBeCloseTo(0.38701, 4);
  });

  test("flat smile -> zero skew; PCR = put OI / call OI", () => {
    const now = Date.UTC(2026, 9, 1, 8);
    const result: unknown[] = [];
    for (const exp of ["16OCT26", "27NOV26"])
      for (let k = 50_000; k <= 130_000; k += 2_000)
        for (const cp of ["C", "P"]) result.push({ instrument_name: `BTC-${exp}-${k}-${cp}`, mark_iv: 50, underlying_price: 90_000, open_interest: cp === "P" ? 1 : 2 });
    const snap = computeOptionsSnapshot({ result }, now);
    expect(snap.skew25d).toBeCloseTo(0, 9);
    expect(snap.putCallOi).toBeCloseTo(0.5, 9);
  });

  test("throws when no expiries bracket 30 days", () => {
    const result = [{ instrument_name: "BTC-16OCT26-90000-C", mark_iv: 50, underlying_price: 90_000, open_interest: 1 }];
    expect(() => computeOptionsSnapshot({ result }, Date.UTC(2026, 9, 1))).toThrow("bracketing 30d");
  });

  test("history cannot be backfilled: each day's snapshot accumulates in the store", async () => {
    const store = memoryVectorStore();
    const load = skewLoader({ store, fetchFn: fetchOf(() => jsonRes(deribitBook)) });
    const t = deribitBook.usIn / 1000;
    await load(t);
    const second = await load(t + DAY);
    expect(second.series!.skew25d).toHaveLength(2);
    expect(second.series!.putCallOi).toHaveLength(2);
  });
});

describe("fred loader", () => {
  test("one series failing is a partial result naming it; the others load", async () => {
    const csv = (id: string) => `observation_date,${id}\n2026-09-24,4.1\n2026-09-25,\n2026-09-26,4.2\n`;
    const io = {
      fetchFn: fetchOf((u) => {
        const id = new URL(u).searchParams.get("id")!;
        return id === "SP500" ? new Response("nope", { status: 500 }) : new Response(csv(id));
      }),
      store: memoryVectorStore(),
    } as unknown as VectorSourceIo;
    const r = await createVectorLoaders(io).fred!(D("2026-09-27"));
    expect(r.series!.DGS10).toEqual([
      { t: D("2026-09-24"), v: 4.1 },
      { t: D("2026-09-26"), v: 4.2 },
    ]);
    expect(r.series!.SP500).toBeUndefined();
    expect(r.error).toContain("SP500");
  });
});
