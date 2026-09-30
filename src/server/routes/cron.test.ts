import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { backfillCoins, backfillRoute, CORE_COINS, cronRoutes } from "./cron.js";

process.env.CRON_TOKEN = "test-cron-token";

const app = new Hono().route("/cron", cronRoutes);

describe("POST /cron/collect", () => {
  test("401s without a valid x-cron-token (does not run any collector)", async () => {
    const res = await app.request("/cron/collect", { method: "POST" });
    expect(res.status).toBe(401);
  });

  test("401s with a wrong token", async () => {
    const res = await app.request("/cron/collect", {
      method: "POST",
      headers: { "x-cron-token": "wrong" },
    });
    expect(res.status).toBe(401);
  });
});

describe("POST /cron/backfill", () => {
  test("401s without a valid x-cron-token", async () => {
    const res = await app.request("/cron/backfill", { method: "POST" });
    expect(res.status).toBe(401);
  });
});

describe("backfillCoins", () => {
  test("core coins plus branch allocations, uppercased and deduped", () => {
    const coins = backfillCoins([
      { allocations: [{ coin: "eth" }, { coin: "PENDLE" }] },
      { allocations: [{ coin: "PENDLE" }, { coin: 3 }] },
      null,
    ]);
    expect(coins).toEqual([...CORE_COINS, "PENDLE"]);
  });

  test("an explicit list replaces the defaults", () => {
    expect(backfillCoins([{ allocations: [{ coin: "PENDLE" }] }], "btc, arb,,BTC")).toEqual(["BTC", "ARB"]);
  });
});

describe("backfillRoute", () => {
  const routeApp = (deps: Parameters<typeof backfillRoute>[0]) => new Hono().post("/b", backfillRoute(deps));

  test("backfills each coin and reports coverage; one failure does not stop the rest", async () => {
    const seen: string[] = [];
    const res = await routeApp({
      listBranches: async () => [{ config: { allocations: [{ coin: "PENDLE" }] } }],
      backfillCoin: async (coin) => {
        seen.push(coin);
        if (coin === "ETH") throw new Error("coingecko 429");
      },
      candleCoverage: async () => ({ min: new Date("2025-10-01T00:00:00Z"), max: new Date("2026-09-30T00:00:00Z") }),
    }).request("/b?days=30", { method: "POST" });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { days: number; results: Record<string, { ok: boolean; error?: string; to?: string }> };
    expect(seen).toEqual([...CORE_COINS, "PENDLE"]);
    expect(body.days).toBe(30);
    expect(body.results.ETH).toEqual({ ok: false, error: "coingecko 429" });
    expect(body.results.BTC?.ok).toBe(true);
    expect(body.results.PENDLE?.to).toBe("2026-09-30T00:00:00.000Z");
  });

  test("rejects an out-of-range days value", async () => {
    const deps = { listBranches: async () => [], backfillCoin: async () => {}, candleCoverage: async () => null };
    expect((await routeApp(deps).request("/b?days=0", { method: "POST" })).status).toBe(400);
    expect((await routeApp(deps).request("/b?days=abc", { method: "POST" })).status).toBe(400);
  });
});
