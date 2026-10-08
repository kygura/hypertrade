import { describe, expect, test } from "bun:test";
import type { Observation, SyncState } from "../db.js";
import { loadDataset } from "./dataset.js";
import {
  collectLab,
  LAB_SOURCES,
  LAB_SYNC_COIN,
  parseBlockchainChart,
  parseCoinMetrics,
  parseDvolHistory,
  parseFngHistory,
  parseStablecoinHistory,
  REFRESH_MS,
  RETRY_MS,
  type LabCollectDeps,
} from "./sources.js";

// Fixtures follow each API's documented response shape.
const D1 = Date.UTC(2024, 0, 1);
const D2 = Date.UTC(2024, 0, 2);
const blockchain = { status: "ok", name: "Hash Rate", unit: "TH/s", period: "day", values: [{ x: D1 / 1000, y: 5.1e8 }, { x: D2 / 1000, y: 5.3e8 }] };
const coinmetrics = {
  data: [
    { asset: "btc", time: "2024-01-01T00:00:00.000000000Z", CapMVRVCur: "1.92" },
    { asset: "btc", time: "2024-01-02T00:00:00.000000000Z", CapMVRVCur: "1.95" },
  ],
};
const fng = { name: "Fear and Greed Index", data: [{ value: "60", value_classification: "Greed", timestamp: String(D2 / 1000) }, { value: "55", value_classification: "Greed", timestamp: String(D1 / 1000) }], metadata: { error: null } };
const llama = [
  { date: String(D1 / 1000), totalCirculating: { peggedUSD: 1.3e11 }, totalCirculatingUSD: { peggedUSD: 1.3e11, peggedEUR: 1e8 } },
  { date: String(D2 / 1000), totalCirculatingUSD: { peggedEUR: 1e8 } },
];
const dvol = { result: { data: [[D1, 50, 52, 48, 51], [D2, 51, 55, 50, 54]], continuation: null } };

describe("parsers", () => {
  test("blockchain.com chart: seconds to ms", () => {
    expect(parseBlockchainChart(blockchain)).toEqual([{ ts: D1, value: 5.1e8 }, { ts: D2, value: 5.3e8 }]);
  });
  test("coin metrics: string values, next page", () => {
    const p = parseCoinMetrics({ ...coinmetrics, next_page_url: "https://x/next" }, "CapMVRVCur");
    expect(p.points).toEqual([{ ts: D1, value: 1.92 }, { ts: D2, value: 1.95 }]);
    expect(p.next).toBe("https://x/next");
  });
  test("fear & greed history comes back ascending", () => {
    expect(parseFngHistory(fng)).toEqual([{ ts: D1, value: 55 }, { ts: D2, value: 60 }]);
  });
  test("stablecoin history keeps USD pegs only and drops rows without them", () => {
    expect(parseStablecoinHistory(llama)).toEqual([{ ts: D1, value: 1.3e11 }]);
  });
  test("dvol history uses the close", () => {
    expect(parseDvolHistory(dvol).points).toEqual([{ ts: D1, value: 51 }, { ts: D2, value: 54 }]);
  });
  test("malformed payloads throw", () => {
    expect(() => parseBlockchainChart({ values: "nope" })).toThrow();
    expect(() => parseCoinMetrics({}, "TxCnt")).toThrow();
  });
});

function fakeFetch(calls: string[], fail?: RegExp): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (fail?.test(url)) return new Response("down", { status: 503 });
    let body: unknown = blockchain;
    if (url.includes("coinmetrics")) {
      const m = /metrics=(\w+)/.exec(url)![1]!;
      body = { data: coinmetrics.data.map((r) => ({ asset: "btc", time: r.time, [m]: r.CapMVRVCur })) };
    } else if (url.includes("alternative.me")) body = fng;
    else if (url.includes("llama")) body = llama;
    else if (url.includes("deribit")) body = dvol;
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
}

function memoryDeps() {
  const state = new Map<string, SyncState>();
  const rows: Observation[] = [];
  const runs: { ok: boolean; error?: string | null }[] = [];
  const deps: LabCollectDeps = {
    getSyncState: async (coin, series) => state.get(`${coin}/${series}`) ?? { coin, series, hlFloor: null, ext: {}, syncedAt: null, accessedAt: null, error: null },
    saveSyncState: async (s) => void state.set(`${s.coin}/${s.series}`, s),
    ensureSeries: async () => {},
    upsertObservations: async (r) => (rows.push(...r), r.length),
    recordCollectorRun: async (_c, _s, ok, error) => void runs.push({ ok, error }),
  };
  return { deps, state, rows, runs };
}

describe("collectLab", () => {
  const now = Date.UTC(2024, 0, 3, 12);

  test("first run pulls full history from every source", async () => {
    const calls: string[] = [];
    const m = memoryDeps();
    const res = await collectLab(fakeFetch(calls), m.deps, { now });
    expect(res.ok).toBe(true);
    expect(res.synced.length).toBe(LAB_SOURCES.length);
    expect(calls.some((u) => u.includes("timespan=all"))).toBe(true);
    expect(calls.some((u) => u.includes("limit=0"))).toBe(true);
    expect(m.rows.some((r) => r.seriesId === "cm.btc.CapMVRVCur" && r.value === 1.95)).toBe(true);
    expect(m.state.get(`${LAB_SYNC_COIN}/bc.hash-rate`)?.syncedAt).toBe(now);
  });

  test("a second run inside the refresh window fetches nothing", async () => {
    const m = memoryDeps();
    await collectLab(fakeFetch([]), m.deps, { now });
    const calls: string[] = [];
    const res = await collectLab(fakeFetch(calls), m.deps, { now: now + REFRESH_MS - 1 });
    expect(calls).toEqual([]);
    expect(res.skipped).toBe(LAB_SOURCES.length);
  });

  test("later runs fetch a short tail", async () => {
    const m = memoryDeps();
    await collectLab(fakeFetch([]), m.deps, { now });
    const calls: string[] = [];
    await collectLab(fakeFetch(calls), m.deps, { now: now + REFRESH_MS + 1 });
    expect(calls.some((u) => u.includes("timespan=60days"))).toBe(true);
    expect(calls.some((u) => u.includes("start_time=2023-12-27"))).toBe(true);
  });

  test("one failing source does not block the rest, and records its error", async () => {
    const m = memoryDeps();
    const res = await collectLab(fakeFetch([], /coinmetrics/), m.deps, { now });
    expect(res.ok).toBe(true);
    expect(res.error).toContain("cm.btc.CapMVRVCur: HTTP 503");
    expect(m.state.get(`${LAB_SYNC_COIN}/cm.btc.TxCnt`)?.syncedAt).toBeNull();
    expect(m.state.get(`${LAB_SYNC_COIN}/cm.btc.TxCnt`)?.error).toContain("503");
    expect(m.rows.some((r) => r.seriesId === "bc.hash-rate")).toBe(true);
  });

  test("a failed source backs off for an hour, then retries", async () => {
    const m = memoryDeps();
    await collectLab(fakeFetch([], /deribit/), m.deps, { now });
    const soon: string[] = [];
    await collectLab(fakeFetch(soon, /deribit/), m.deps, { now: now + RETRY_MS - 1 });
    expect(soon.some((u) => u.includes("deribit"))).toBe(false);
    const later: string[] = [];
    await collectLab(fakeFetch(later), m.deps, { now: now + RETRY_MS + 1 });
    expect(later.some((u) => u.includes("deribit"))).toBe(true);
    expect(m.state.get(`${LAB_SYNC_COIN}/deribit.btc_dvol`)?.error).toBeNull();
  });

  test("a passed deadline skips sources instead of starting them", async () => {
    const calls: string[] = [];
    const res = await collectLab(fakeFetch(calls), memoryDeps().deps, { now, deadline: Date.now() - 1 });
    expect(calls).toEqual([]);
    expect(res.skipped).toBe(LAB_SOURCES.length);
  });
});

describe("loadDataset", () => {
  const day = (i: number) => new Date(Date.UTC(2024, 0, 1 + i));
  test("aligns bases with their lag and drops today's forming bar", async () => {
    const ds = await loadDataset(
      ["cm.btc.CapMVRVCur", "fund.BTC"],
      {
        getCandles: async () => [0, 1, 2, 3].map((i) => ({ ts: day(i), c: 100 + i })),
        seriesRange: async () => [0, 1, 2].map((i) => ({ ts: day(i), value: 1 + i / 10 })),
        dailyFunding: async () => [{ ts: day(1), rate: 0.00001 }],
      },
      Date.UTC(2024, 0, 4, 9), // day 3 is today
    );
    expect(ds.days.length).toBe(3);
    expect(Array.from(ds.close)).toEqual([100, 101, 102]);
    const mvrv = ds.bases["cm.btc.CapMVRVCur"]!;
    expect(Number.isNaN(mvrv[0]!)).toBe(true); // lag 1: day 0's value is usable on day 1
    expect(mvrv[1]).toBeCloseTo(1, 10);
    expect(ds.bases["fund.BTC"]![1]).toBeCloseTo(8.76, 6); // 0.001%/h annualized
  });
});
