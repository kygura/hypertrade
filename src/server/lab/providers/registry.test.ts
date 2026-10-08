import { describe, expect, test } from "bun:test";
import { UpstreamError } from "../../mcp/types.js";
import type { DailySeries, LabProvider, MetricDef } from "../types.js";
import { alignToCalendar, allMetrics, fetchMetric, getMetric, loadDataset, type RegistryDeps } from "./registry.js";
import { clip, toDaily } from "./series.js";

const D0 = Date.UTC(2024, 0, 1);
const DAY = 86_400_000;
const H = 3_600_000;
const days = (n: number, start = D0) => Array.from({ length: n }, (_, i) => start + i * DAY);

describe("toDaily", () => {
  const pts = [
    { t: D0 + 5 * H, v: 2 },
    { t: D0 + 1 * H, v: 1 },
    { t: D0 + DAY + 3 * H, v: 10 },
    { t: D0 + 2 * H, v: NaN },
    { t: D0 + 9 * H, v: Infinity },
  ];
  test("last keeps the latest point by time", () => expect(toDaily(pts, "last")).toEqual({ t: [D0, D0 + DAY], v: [2, 10] }));
  test("sum", () => expect(toDaily(pts, "sum")).toEqual({ t: [D0, D0 + DAY], v: [3, 10] }));
  test("mean", () => expect(toDaily(pts, "mean")).toEqual({ t: [D0, D0 + DAY], v: [1.5, 10] }));
  test("clip is inclusive on day boundaries", () =>
    expect(clip({ t: days(5), v: [1, 2, 3, 4, 5] }, D0 + DAY + H, D0 + 3 * DAY)).toEqual({ t: days(3, D0 + DAY), v: [2, 3, 4] }));
});

describe("alignToCalendar", () => {
  test("forward-fills at most three days, NaN before start", () => {
    const cal = days(10);
    const s = { t: [D0 + DAY, D0 + 2 * DAY], v: [5, 6] };
    expect(alignToCalendar(s, cal)).toEqual([NaN, 5, 6, 6, 6, 6, NaN, NaN, NaN, NaN]);
  });
  test("lag shifts a value to the day it is known", () => {
    expect(alignToCalendar({ t: days(3), v: [1, 2, 3] }, days(4), 1)).toEqual([NaN, 1, 2, 3]);
  });
});

// ---------------------------------------------------------------- fakes

function def(provider: string, key: string, over: Partial<MetricDef> = {}): MetricDef {
  return { id: `${provider}:${key}`, provider, key, name: key, category: "onchain", scope: "asset", description: key, lagDays: 0, ...over };
}

function fakeProvider(id: string, defs: MetricDef[], data: Record<string, DailySeries | Error>, calls: string[] = []): LabProvider {
  return {
    id,
    name: id,
    notes: "",
    metrics: () => defs,
    async fetch(key, asset) {
      calls.push(`${id}:${key}:${asset}`);
      const d = data[key];
      if (d instanceof Error) throw d;
      return d ?? { t: [], v: [] };
    },
  };
}

const price: DailySeries = { t: days(10), v: [100, 101, 102, 103, 104, 105, 106, 107, 108, 109] };

function setup(over: { htPrice?: DailySeries | Error } = {}) {
  const calls: string[] = [];
  const ht = fakeProvider("ht", [def("ht", "price", { category: "price" }), def("ht", "funding")], { price: over.htPrice ?? price, funding: { t: days(10), v: days(10).map((_, i) => i) } }, calls);
  const cm = fakeProvider(
    "cm",
    [def("cm", "PriceUSD", { category: "price", lagDays: 1 }), def("cm", "CapMVRVCur", { lagDays: 1 }), def("cm", "HashRate", { lagDays: 1 })],
    { PriceUSD: { t: days(10), v: price.v.map((v) => v + 1) }, CapMVRVCur: { t: days(3), v: [1, 2, 3] }, HashRate: new Error("cm HashRate ETH: HTTP 403") },
    calls,
  );
  const g = fakeProvider("fng", [def("fng", "value", { scope: "global", category: "sentiment" })], { value: { t: [D0, D0 + 5 * DAY], v: [50, 60] } }, calls);
  const deps: RegistryDeps = { providers: [ht, cm, g], cache: new Map(), now: () => D0 + 9 * DAY };
  return { deps, calls };
}

describe("registry", () => {
  test("catalogue lookup and filters over the real providers", () => {
    expect(getMetric("cm:CapMVRVCur")?.lagDays).toBe(1);
    expect(getMetric("ht:price")?.scope).toBe("asset");
    expect(getMetric("nope:x")).toBeUndefined();
    const ids = allMetrics().map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ["fng:value", "llama:stablecoin_cap", "llama:defi_tvl", "cm:PriceUSD", "ht:funding"]) expect(ids).toContain(id);
    expect(allMetrics({ provider: "llama" })).toHaveLength(2);
    expect(allMetrics({ category: "sentiment" }).every((m) => m.category === "sentiment")).toBe(true);
  });

  test("fetchMetric throws on an unknown id and caches per id+asset+range", async () => {
    const { deps, calls } = setup();
    expect(() => fetchMetric("cm:Nope", "BTC", D0, D0 + DAY, deps)).toThrow("unknown metric: cm:Nope");
    await fetchMetric("cm:CapMVRVCur", "BTC", D0, D0 + DAY, deps);
    await fetchMetric("cm:CapMVRVCur", "BTC", D0, D0 + DAY, deps);
    await fetchMetric("cm:CapMVRVCur", "ETH", D0, D0 + DAY, deps);
    await fetchMetric("fng:value", "BTC", D0, D0 + DAY, deps);
    await fetchMetric("fng:value", "ETH", D0, D0 + DAY, deps); // global: asset not in the key
    expect(calls).toEqual(["cm:CapMVRVCur:BTC", "cm:CapMVRVCur:ETH", "fng:value:BTC"]);
  });

  test("a failed fetch is not cached", async () => {
    const { deps, calls } = setup();
    await fetchMetric("cm:HashRate", "BTC", D0, D0 + DAY, deps).catch(() => {});
    await Promise.resolve();
    await fetchMetric("cm:HashRate", "BTC", D0, D0 + DAY, deps).catch(() => {});
    expect(calls).toEqual(["cm:HashRate:BTC", "cm:HashRate:BTC"]);
  });
});

describe("loadDataset", () => {
  test("aligns metrics to the price calendar with lag, ffill limit and failure warnings", async () => {
    const { deps } = setup();
    const { dataset, warnings } = await loadDataset(
      { asset: "BTC", metrics: ["ht:funding", "cm:CapMVRVCur", "fng:value", "cm:HashRate"], from: "2024-01-01", to: "2024-01-10" },
      deps,
    );
    expect(dataset.asset).toBe("BTC");
    expect(dataset.t).toEqual(price.t);
    expect(dataset.price).toEqual(price.v);
    expect(dataset.metrics["ht:funding"]).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    // stamped Jan 1..3, lag 1 → known Jan 2..4, then ffill 3 days (to Jan 7), then NaN
    expect(dataset.metrics["cm:CapMVRVCur"]).toEqual([NaN, 1, 2, 3, 3, 3, 3, NaN, NaN, NaN]);
    expect(dataset.metrics["fng:value"]).toEqual([50, 50, 50, 50, NaN, 60, 60, 60, 60, NaN]);
    expect("cm:HashRate" in dataset.metrics).toBe(false);
    expect(warnings).toEqual(["cm:HashRate: cm HashRate ETH: HTTP 403; dropped"]);
  });

  test("unknown metric id throws before any fetch", async () => {
    const { deps, calls } = setup();
    await expect(loadDataset({ asset: "BTC", metrics: ["ht:funding", "xx:y"] }, deps)).rejects.toThrow("unknown metric: xx:y");
    expect(calls).toEqual([]);
  });

  test("falls back to cm:PriceUSD when ht has no price, with a warning", async () => {
    const { deps } = setup({ htPrice: { t: [], v: [] } });
    const { dataset, warnings } = await loadDataset({ asset: "BTC", metrics: ["ht:funding"] }, deps);
    expect(dataset.price[0]).toBe(101);
    expect(warnings).toEqual(["ht:price has no history for BTC; using cm:PriceUSD"]);
  });

  test("falls back when ht price errors too, and throws when nothing has price", async () => {
    const { deps } = setup({ htPrice: new Error("HL 500") });
    const { warnings } = await loadDataset({ asset: "BTC", metrics: [] }, deps);
    expect(warnings).toEqual(["ht:price unavailable (HL 500); using cm:PriceUSD"]);
    const explicit = setup({ htPrice: { t: [], v: [] } });
    await expect(loadDataset({ asset: "BTC", metrics: [], price: "ht:price" }, explicit.deps)).rejects.toThrow("no price history for BTC: ht:price: no history");
  });

  test("deadline reaches every provider fetch", async () => {
    const { deps } = setup();
    const seen: unknown[] = [];
    const providers = deps.providers!.map((p) => ({ ...p, fetch: (...a: Parameters<typeof p.fetch>) => (seen.push(a[4]), p.fetch(...a)) }));
    await loadDataset({ asset: "BTC", metrics: ["ht:funding"], deadline: true }, { ...deps, providers });
    expect(seen).toEqual([{ deadline: true }, { deadline: true }]);
  });

  test("every price attempt failing → UpstreamError naming each reason", async () => {
    const { deps } = setup({ htPrice: new Error("HL 500") });
    const providers = deps.providers!.map((p) => (p.id === "cm" ? { ...p, fetch: async () => Promise.reject(new Error("cm HTTP 429")) } : p));
    const err = await loadDataset({ asset: "BTC", metrics: [] }, { ...deps, providers }).catch((e) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect(err.message).toBe("no price history for BTC: ht:price: HL 500; cm:PriceUSD: cm HTTP 429");
  });

  test("a metric with no data in range is dropped with a warning", async () => {
    const { deps } = setup();
    const { dataset, warnings } = await loadDataset({ asset: "BTC", metrics: ["cm:CapMVRVCur"], from: "2024-01-01", to: "2024-01-10" }, {
      ...deps,
      providers: deps.providers!.map((p) => (p.id === "cm" ? { ...p, fetch: async () => ({ t: [], v: [] }) } : p)),
    });
    expect(dataset.metrics).toEqual({});
    expect(warnings).toEqual(["cm:CapMVRVCur: no data for BTC in range; dropped"]);
  });
});
