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
  test("core coins, branch coins, then recently charted coins; stables dropped", () => {
    const coins = backfillCoins(
      [{ allocations: [{ coin: "pendle" }, { coin: "USDC" }, { coin: "BTC" }] }, null, { nope: 1 }],
      undefined,
      ["kPEPE", "ETH"],
    );
    expect(coins).toEqual([...CORE_COINS, "PENDLE", "kPEPE"]);
  });

  test("an explicit list replaces the defaults", () => {
    expect(backfillCoins([{ allocations: [{ coin: "PENDLE" }] }], "btc, arb,,BTC", ["DOGE"])).toEqual(["BTC", "ARB"]);
  });
});

describe("backfillRoute", () => {
  const routeApp = (deps: Parameters<typeof backfillRoute>[0]) => new Hono().post("/b", backfillRoute(deps));
  const base = {
    listBranches: async () => [],
    recentCoins: async () => [],
    warmCoin: async () => ({ tfs: 8 }),
    prune: async () => ({ "1m": 0, "5m": 0 }),
    now: () => Date.UTC(2026, 8, 30),
  };

  test("warms each coin and reports coverage; one failure does not stop the rest", async () => {
    const seen: string[] = [];
    const res = await routeApp({
      ...base,
      listBranches: async () => [{ config: { allocations: [{ coin: "PENDLE" }] } }],
      recentCoins: async () => ["DOGE"],
      warmCoin: async (coin, startDate) => {
        seen.push(coin);
        if (coin === "ETH") throw new Error("HL 429");
        expect(startDate.toISOString()).toBe("2026-08-31T00:00:00.000Z");
        return { from: "2017-08-17T00:00:00.000Z", to: "2026-09-30T00:00:00.000Z", tfs: 8, fundingFrom: null };
      },
    }).request("/b?days=30", { method: "POST" });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { days: number; results: Record<string, { ok: boolean; error?: string; to?: string }>; pruned: unknown };
    expect(seen).toEqual([...CORE_COINS, "PENDLE", "DOGE"]);
    expect(body.days).toBe(30);
    expect(body.results.ETH).toEqual({ ok: false, error: "HL 429" });
    expect(body.results.BTC?.ok).toBe(true);
    expect(body.results.PENDLE?.to).toBe("2026-09-30T00:00:00.000Z");
    expect(body.pruned).toEqual({ "1m": 0, "5m": 0 });
  });

  test("coins past the deadline are skipped, not started", async () => {
    let t = 0;
    const res = await routeApp({
      ...base,
      now: () => t,
      warmCoin: async () => {
        t += 100_000; // each coin eats most of the budget
        return { tfs: 8 };
      },
    }).request("/b", { method: "POST" });
    const body = (await res.json()) as { results: Record<string, { ok: boolean; skipped?: boolean; tfs?: number }> };
    expect(body.results.BTC).toEqual({ ok: true, tfs: 8 });
    expect(body.results.ETH).toEqual({ ok: true, tfs: 8 });
    expect(body.results.SOL).toEqual({ ok: false, skipped: true });
  });

  test("a hung step still gets an answer before the platform kills the function", async () => {
    let release!: () => void;
    const res = await routeApp({
      ...base,
      hardStopMs: 20,
      warmCoin: async (coin, _start, _deadline, step) => {
        step(`${coin} head 1m`);
        if (coin === "ETH") await new Promise<void>((r) => (release = r));
        return { tfs: 8 };
      },
    }).request("/b", { method: "POST" });
    release();
    const body = (await res.json()) as { timedOut?: boolean; inFlight?: string; results: Record<string, { ok: boolean; skipped?: boolean; tfs?: number }> };
    expect(res.status).toBe(200);
    expect(body.timedOut).toBe(true);
    expect(body.inFlight).toBe("ETH head 1m");
    expect(body.results.BTC).toEqual({ ok: true, tfs: 8 });
    expect(body.results.SOL).toEqual({ ok: false, skipped: true });
  });

  test("rejects an out-of-range days value", async () => {
    expect((await routeApp(base).request("/b?days=0", { method: "POST" })).status).toBe(400);
    expect((await routeApp(base).request("/b?days=abc", { method: "POST" })).status).toBe(400);
  });
});
