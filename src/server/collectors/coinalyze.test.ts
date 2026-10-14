import { describe, expect, test } from "bun:test";
import fixture from "../../shared/fixtures/coinalyze.json" with { type: "json" };
import { MemoryIntelStore } from "../intel/store.js";
import { CALLS_PER_RUN, COINALYZE_COLLECTOR, collectCoinalyze, flowCoins, maxFlowCoins, symbolMap, type FlowCollectDeps } from "./coinalyze.js";

const NOW = Date.parse("2026-10-14T12:00:00Z");
const T0 = new Date(1791975600 * 1000).toISOString();
const T1 = new Date(1791976500 * 1000).toISOString();

type Call = { path: string; params: URLSearchParams; key: string | null };

function setup(o: { coins?: string[]; env?: Record<string, string>; respond?: (path: string) => Response | undefined } = {}) {
  const store = new MemoryIntelStore(() => new Date(NOW));
  const calls: Call[] = [];
  const runs: Array<{ collector: string; ok: boolean; error: string | null | undefined }> = [];
  const fetchFn = (async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/v1\//, "");
    calls.push({ path, params: url.searchParams, key: new Headers(init?.headers).get("api_key") });
    const r = o.respond?.(path);
    if (r) return r;
    const body = (fixture as Record<string, unknown>)[path];
    return body ? Response.json(body) : new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  const deps: FlowCollectDeps = {
    fetch: fetchFn,
    store,
    coins: async () => o.coins ?? ["BTC", "kPEPE", "DOGE"],
    recordRun: async (collector, _s, ok, error) => void runs.push({ collector, ok, error }),
    env: o.env ?? { COINALYZE_API_KEY: "k-test" },
    now: () => NOW,
  };
  return { deps, store, calls, runs };
}

describe("symbolMap", () => {
  test("aggregated perp per listed base asset (kPEPE → PEPE); spot by exchange rank then USDT > USD > USDC", () => {
    const m = symbolMap(fixture["future-markets"], fixture["spot-markets"], ["BTC", "kPEPE", "ETH", "DOGE"]);
    expect(m.get("BTC")).toEqual({ perp: "BTCUSDT_PERP.A", spot: { symbol: "BTCUSD.C", venue: "C" } });
    expect(m.get("kPEPE")).toEqual({ perp: "PEPEUSDT_PERP.A", spot: { symbol: "PEPEUSDT.Z", venue: "Z" } });
    expect(m.has("ETH")).toBe(false); // only a dated future, no spot
    expect(m.has("DOGE")).toBe(false);
  });

  test("garbage lists map nothing", () => {
    expect(symbolMap({ error: "x" }, null, ["BTC"]).size).toBe(0);
  });
});

describe("flowCoins / maxFlowCoins", () => {
  test("held by notional, then watched, deduped and capped", () => {
    const positions = [{ asset: "ETH", notionalUsd: 500 }, { asset: "SOL", notionalUsd: -2000 }, { asset: "ETH", notionalUsd: 100 }];
    expect(flowCoins(positions, ["BTC", "SOL", "HYPE"], 3)).toEqual(["SOL", "ETH", "BTC"]);
  });
  test("INTEL_FLOW_MAX_COINS default 8, clamped to 1..20", () => {
    expect(maxFlowCoins({})).toBe(8);
    expect(maxFlowCoins({ INTEL_FLOW_MAX_COINS: "50" })).toBe(20);
    expect(maxFlowCoins({ INTEL_FLOW_MAX_COINS: "0" })).toBe(1);
    expect(maxFlowCoins({ INTEL_FLOW_MAX_COINS: " " })).toBe(8);
  });
});

describe("collectCoinalyze", () => {
  test("no key: recorded as skipped, nothing fetched", async () => {
    const { deps, calls, runs } = setup({ env: {} });
    expect(await collectCoinalyze(deps)).toMatchObject({ ok: true, written: 0, error: "skipped:no-key" });
    expect(calls).toEqual([]);
    expect(runs).toEqual([{ collector: COINALYZE_COLLECTOR, ok: true, error: "skipped:no-key" }]);
  });

  test("maps every endpoint to per-interval flow rows", async () => {
    const { deps, store, calls, runs } = setup();
    const r = await collectCoinalyze(deps);
    expect(r).toMatchObject({ ok: true, coins: 3, errors: [] });
    expect(calls.every((c) => c.key === "k-test")).toBe(true);
    expect(calls.map((c) => c.path)).toEqual([
      "future-markets",
      "spot-markets",
      "liquidation-history",
      "ohlcv-history",
      "ohlcv-history",
      "long-short-ratio-history",
      "open-interest-history",
      "funding-rate-history",
    ]);
    const liq = calls[2]!.params;
    expect(liq.get("symbols")).toBe("BTCUSDT_PERP.A,PEPEUSDT_PERP.A");
    expect(liq.get("interval")).toBe("15min");
    expect(liq.get("convert_to_usd")).toBe("true");
    expect(Number(liq.get("from"))).toBe((NOW - 24 * 3_600_000) / 1000);
    expect(calls[4]!.params.get("symbols")).toBe("BTCUSD.C,PEPEUSDT.Z");
    expect(r.calls).toBe(2 + 2 * 6);

    const btc = await store.flowSeries("BTC", null, new Date(0));
    const at = (metric: string, ts = T0) => btc.find((x) => x.metric === metric && x.ts === ts);
    expect(at("liq_long_usd")).toEqual({ asset: "BTC", venue: "agg", metric: "liq_long_usd", value: 120000.5, ts: T0 });
    expect(at("liq_long_usd", T1)?.value).toBe(0);
    expect(at("liq_short_usd", T1)?.value).toBe(15000);
    expect(at("perp_volume_usd")?.value).toBe(250.5 * 100000);
    expect(at("perp_buy_volume_usd")?.value).toBe(130.25 * 100000);
    expect(at("spot_volume_usd")).toMatchObject({ venue: "C", value: 40 * 100000 });
    expect(at("long_short_ratio")?.value).toBe(1.85);
    expect(at("oi_usd")?.value).toBe(8.15e9);
    expect(at("funding")?.value).toBeCloseTo(0.000105, 12);
    expect((await store.flowSeries("kPEPE", "liq_short_usd", new Date(0)))[0]).toMatchObject({ venue: "agg", value: 700 });
    expect(r.written).toBe(btc.length + (await store.flowSeries("kPEPE", null, new Date(0))).length);
    expect(runs).toEqual([{ collector: COINALYZE_COLLECTOR, ok: true, error: null }]);
  });

  test("from = the oldest last stored ts in the batch", async () => {
    const { deps, store, calls } = setup({ coins: ["BTC"] });
    const last = new Date(NOW - 2 * 3_600_000).toISOString();
    await store.insertFlow([{ asset: "BTC", venue: "agg", metric: "liq_long_usd", value: 1, ts: last }]);
    await collectCoinalyze(deps);
    expect(Number(calls.find((c) => c.path === "liquidation-history")!.params.get("from"))).toBe(Date.parse(last) / 1000);
    expect(Number(calls.find((c) => c.path === "open-interest-history")!.params.get("from"))).toBe((NOW - 24 * 3_600_000) / 1000);
  });

  test("stays within CALLS_PER_RUN: endpoints that would exceed it are skipped and named", async () => {
    const coins = Array.from({ length: 20 }, (_, i) => `C${i}`);
    const futures = coins.map((c) => ({ symbol: `${c}USDT_PERP.A`, base_asset: c, quote_asset: "USDT", is_perpetual: true }));
    const { deps, calls } = setup({ coins, respond: (p) => (p === "future-markets" ? Response.json(futures) : p === "spot-markets" ? Response.json([]) : undefined) });
    const r = await collectCoinalyze(deps);
    expect(r.calls).toBeLessThanOrEqual(CALLS_PER_RUN);
    expect(calls.map((c) => c.path)).toEqual(["future-markets", "spot-markets", "liquidation-history"]);
    expect(r.errors).toContain("ohlcv-history (perp): skipped, call budget");
  });

  test("an endpoint error is recorded and the rest still run; 429 stops the run; nothing throws", async () => {
    const one = setup({ respond: (p) => (p === "liquidation-history" ? new Response("boom", { status: 500 }) : undefined) });
    const r1 = await collectCoinalyze(one.deps);
    expect(r1).toMatchObject({ ok: true, errors: ["liquidation-history (perp): liquidation-history: HTTP 500"] });
    expect(r1.written).toBeGreaterThan(0);
    expect(one.runs[0]).toMatchObject({ ok: true, error: "liquidation-history (perp): liquidation-history: HTTP 500" });

    const limited = setup({ respond: (p) => (p === "ohlcv-history" ? new Response("", { status: 429 }) : undefined) });
    const r2 = await collectCoinalyze(limited.deps);
    expect(r2).toMatchObject({ ok: false, error: "ohlcv-history: rate limited (429)" });
    expect(limited.calls.map((c) => c.path).at(-1)).toBe("ohlcv-history");
    expect(limited.runs[0]).toMatchObject({ ok: false });

    const down = setup({ respond: () => Response.json({ error: "Invalid/Missing API key" }, { status: 401 }) });
    expect(await collectCoinalyze(down.deps)).toMatchObject({ ok: false, error: "future-markets: HTTP 401" });
  });
});
