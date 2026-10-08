import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { backfillCoins, backfillRoute, CORE_COINS, cronRoutes, LAB_BUDGET_MS, LAB_HARD_STOP_MS, LAB_LEASE_MS, runLabCollect, type LabLease } from "./cron.js";

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

describe("POST /cron/lab-collect", () => {
  test("401s without a valid x-cron-token", async () => {
    expect((await app.request("/cron/lab-collect", { method: "POST" })).status).toBe(401);
    expect((await app.request("/cron/lab-collect")).status).toBe(401);
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

  test("dca coins are included", () => {
    expect(backfillCoins([{ allocations: [{ coin: "BTC" }], dca: [{ coin: "pendle" }] }])).toEqual([...CORE_COINS, "PENDLE"]);
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

  test("a hung coin listing also gets an answer", async () => {
    const res = await routeApp({
      ...base,
      hardStopMs: 20,
      listBranches: () => new Promise(() => {}),
    }).request("/b", { method: "POST" });
    const body = (await res.json()) as { timedOut?: boolean; inFlight?: string };
    expect(res.status).toBe(200);
    expect(body.timedOut).toBe(true);
    expect(body.inFlight).toBe("list coins");
  });

  test("rejects an out-of-range days value", async () => {
    expect((await routeApp(base).request("/b?days=0", { method: "POST" })).status).toBe(400);
    expect((await routeApp(base).request("/b?days=abc", { method: "POST" })).status).toBe(400);
  });
});

/** In-memory stand-in for the sync_state lease: free, or held by one holder until `until`. */
function memoryLease(clock: { t: number }) {
  let held: { holder: string; until: number } | null = null;
  const log: string[] = [];
  const lease: LabLease = {
    acquire: async (holder, ttlMs) => {
      if (held && held.until > clock.t) return (log.push("busy"), false);
      held = { holder, until: clock.t + ttlMs };
      return (log.push("acquire"), true);
    },
    release: async (holder) => {
      if (held?.holder === holder) held = { holder, until: clock.t };
      log.push("release");
    },
  };
  return { lease, log, held: () => held };
}

describe("runLabCollect", () => {
  test("gives the lab collector its own budget and reports its result", async () => {
    let seen: unknown;
    const { lease, log } = memoryLease({ t: 0 });
    const res = await runLabCollect(
      async (_deps, opts) => {
        seen = opts;
        return { ok: true, written: 3, sources: { "lab.fng.value": "ok", "lab.bc.hash_rate": "skipped" } };
      },
      1_000,
      lease,
    );
    expect(seen).toMatchObject({ deadline: 1_000 + LAB_BUDGET_MS });
    // Inside Vercel's 300 s and the workflow curl's --max-time 290.
    expect(LAB_BUDGET_MS).toBeLessThanOrEqual(240_000);
    expect(LAB_HARD_STOP_MS).toBeLessThanOrEqual(250_000);
    expect(LAB_LEASE_MS).toBe(LAB_BUDGET_MS + 60_000);
    expect(res).toEqual({ ok: true, written: 3, sources: { "lab.fng.value": "ok", "lab.bc.hash_rate": "skipped" } });
    expect(log).toEqual(["acquire", "release"]);
  });

  test("a thrown collector becomes an error result and still releases the lease", async () => {
    const { lease, log } = memoryLease({ t: 0 });
    const res = await runLabCollect(async () => Promise.reject(new Error("sync_state missing")), 0, lease);
    expect(res).toEqual({ ok: false, error: "sync_state missing", written: 0, sources: {} });
    expect(log).toEqual(["acquire", "release"]);
  });

  test("an overlapping run gets busy and never starts the collector; the lease frees after the run or its expiry", async () => {
    const clock = { t: 0 };
    const { lease } = memoryLease(clock);
    let runs = 0;
    let finish!: () => void;
    const slow = () => {
      runs++;
      return new Promise<{ ok: true; written: 0; sources: {} }>((r) => (finish = () => r({ ok: true, written: 0, sources: {} })));
    };
    const first = runLabCollect(slow, 0, lease);
    await Promise.resolve();
    const second = await runLabCollect(slow, 0, lease);
    expect(second).toEqual({ ok: true, busy: true, written: 0, sources: {} });
    expect(runs).toBe(1);
    finish();
    await first;
    expect((await runLabCollect(async () => ({ ok: true, written: 0, sources: {} }), 0, lease)).ok).toBe(true);
    expect(runs).toBe(1);
    // A run killed before release: the next one waits out the lease, then runs.
    const stuck = memoryLease(clock);
    await stuck.lease.acquire("dead", LAB_LEASE_MS);
    expect(await runLabCollect(async () => ({ ok: true, written: 1, sources: {} }), 0, stuck.lease)).toMatchObject({ busy: true });
    clock.t += LAB_LEASE_MS;
    expect(await runLabCollect(async () => ({ ok: true, written: 1, sources: {} }), 0, stuck.lease)).toEqual({ ok: true, written: 1, sources: {} });
  });

  test("a run still going at the hard stop answers with what finished; the lease is released when it ends", async () => {
    const { lease, log } = memoryLease({ t: 0 });
    let finish!: () => void;
    const res = await runLabCollect(
      (_deps, opts) => {
        opts!.progress!.sources["lab.fng.value"] = "ok";
        opts!.progress!.written = 7;
        opts!.log!("[lab-collect] +12.0s lab.bc.hash_rate fetch");
        return new Promise((r) => (finish = () => r({ ok: true, written: 7, sources: {} })));
      },
      0,
      lease,
      20,
    );
    expect(res).toEqual({
      ok: false,
      error: "still running after 0s; last: [lab-collect] +12.0s lab.bc.hash_rate fetch",
      written: 7,
      sources: { "lab.fng.value": "ok" },
      timedOut: true,
      inFlight: "[lab-collect] +12.0s lab.bc.hash_rate fetch",
    });
    // Still running: the lease stays held so no second run starts on top of it.
    expect(log).toEqual(["acquire"]);
    finish();
    await new Promise((r) => setTimeout(r, 0));
    expect(log).toEqual(["acquire", "release"]);
  });

  test("an unreadable lease is an error result, not a run", async () => {
    let ran = false;
    const lease: LabLease = { acquire: () => Promise.reject(new Error("db down")), release: async () => {} };
    const res = await runLabCollect(async () => ((ran = true), { ok: true, written: 0, sources: {} }), 0, lease);
    expect(res).toEqual({ ok: false, error: "db down", written: 0, sources: {} });
    expect(ran).toBe(false);
  });
});
