import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import {
  backfillCoins,
  backfillRoute,
  CORE_COINS,
  cronRoutes,
  INTEL_BUDGET_MS,
  INTEL_HARD_STOP_MS,
  INTEL_LEASE_MS,
  intelCronRoute,
  intelSettingKey,
  LAB_BUDGET_MS,
  LAB_HARD_STOP_MS,
  LAB_LEASE_MS,
  runLabCollect,
  type IntelCronDeps,
  type IntelJob,
  type IntelJobRun,
  type LabLease,
} from "./cron.js";

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

  test("no database: the rows come back as a spill, and a replayed spill is merged into the next one", async () => {
    // No database: every write fails at once, as a wedged one does after FLUSH_BUDGET_MS.
    const saved = { url: process.env.DATABASE_URL, pg: process.env.DATABASE_POSTGRES_URL, pooled: process.env.POSTGRES_URL, fetch: globalThis.fetch };
    delete process.env.DATABASE_URL;
    delete process.env.DATABASE_POSTGRES_URL;
    delete process.env.POSTGRES_URL;
    globalThis.fetch = (async () => new Response("blocked", { status: 403 })) as unknown as typeof fetch;
    const post = (body?: unknown) =>
      app.request("/cron/collect", {
        method: "POST",
        headers: { "x-cron-token": "test-cron-token", "content-type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    try {
      const res = await post();
      expect(res.status).toBe(200);
      const body = (await res.json()) as { threw?: string[]; flush: { spilled: number; errors: string[] }; spill: { runs: { collector: string }[] } };
      expect(body.threw).toBeUndefined();
      expect(body.flush.errors.join(" ")).toContain("DATABASE_URL is not set");
      // Every collector's run record is kept for the next run.
      expect(body.spill.runs.map((r) => r.collector).sort()).toEqual(["crypto-context", "elfa", "fred", "hyperliquid"]);

      const old = { seriesId: "test.series", ts: "2026-10-17T00:00:00.000Z", value: 1 };
      const again = await post({ replay: { ...body.spill, series: [{ id: "test.series" }], observations: [old] } });
      const next = (await again.json()) as { flush: { replayed: number }; spill: { observations: unknown[]; runs: unknown[] } };
      expect(next.flush.replayed).toBe(body.spill.runs.length + 1);
      expect(next.spill.observations).toContainEqual(old);
      expect(next.spill.runs.length).toBeGreaterThan(body.spill.runs.length);
    } finally {
      globalThis.fetch = saved.fetch;
      for (const [k, v] of [["DATABASE_URL", saved.url], ["DATABASE_POSTGRES_URL", saved.pg], ["POSTGRES_URL", saved.pooled]] as const) if (v !== undefined) process.env[k] = v;
    }
  });

  test("400s on a malformed replay", async () => {
    const res = await app.request("/cron/collect", {
      method: "POST",
      headers: { "x-cron-token": "test-cron-token", "content-type": "application/json" },
      body: JSON.stringify({ replay: { observations: [{ seriesId: "x", ts: "yesterday", value: 1 }] } }),
    });
    expect(res.status).toBe(400);
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

  test("Intel held ∪ watched coins join the set", () => {
    expect(backfillCoins([], undefined, ["DOGE"], ["kPEPE", "BTC", "USDC"])).toEqual([...CORE_COINS, "DOGE", "kPEPE"]);
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
      intelCoins: async () => ["WIF"],
      warmCoin: async (coin, startDate) => {
        seen.push(coin);
        if (coin === "ETH") throw new Error("HL 429");
        expect(startDate.toISOString()).toBe("2026-08-31T00:00:00.000Z");
        return { from: "2017-08-17T00:00:00.000Z", to: "2026-09-30T00:00:00.000Z", tfs: 8, fundingFrom: null };
      },
    }).request("/b?days=30", { method: "POST" });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { days: number; results: Record<string, { ok: boolean; error?: string; to?: string }>; pruned: unknown };
    expect(seen).toEqual([...CORE_COINS, "PENDLE", "DOGE", "WIF"]);
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

describe("Intel cron routes", () => {
  test("401 without a valid x-cron-token, on GET and POST", async () => {
    for (const job of ["ingest", "brief", "graph", "watch"]) {
      expect((await app.request(`/cron/intel/${job}`, { method: "POST" })).status).toBe(401);
      expect((await app.request(`/cron/intel/${job}`, { headers: { "x-cron-token": "wrong" } })).status).toBe(401);
    }
  });

  const H = 3_600_000;
  function intelApp(o: { env?: Record<string, string>; run?: Partial<Record<IntelJob, IntelJobRun>>; hardStopMs?: number; clock?: { t: number } } = {}) {
    const clock = o.clock ?? { t: Date.parse("2026-10-13T12:00:00Z") };
    const leases = new Map<string, ReturnType<typeof memoryLease>>();
    const settings = new Map<string, unknown>();
    const calls: Array<{ job: IntelJob; budgetMs: number; aborted: boolean }> = [];
    const ok: IntelJobRun = async () => ({ ok: true, complete: true, result: { n: 1 } });
    const track = (job: IntelJob): IntelJobRun => async (opts) => {
      calls.push({ job, budgetMs: opts.budgetMs, aborted: opts.signal.aborted });
      return (o.run?.[job] ?? ok)(opts);
    };
    const deps: IntelCronDeps = {
      lease: (job) => {
        if (!leases.has(job)) leases.set(job, memoryLease(clock));
        return leases.get(job)!.lease;
      },
      settings: {
        getSetting: async <T,>(k: string) => (settings.get(k) as T) ?? null,
        setSetting: async (k: string, v: unknown) => void settings.set(k, v),
      },
      run: { ingest: track("ingest"), brief: track("brief"), graph: track("graph"), watch: track("watch") },
      env: o.env ?? {},
      now: () => clock.t,
      hardStopMs: o.hardStopMs,
    };
    const a = new Hono();
    for (const job of ["ingest", "brief", "graph", "watch"] as IntelJob[]) a.post(`/cron/intel/${job}`, intelCronRoute(job, () => deps));
    const post = async (job: IntelJob) => {
      const res = await a.request(`/cron/intel/${job}`, { method: "POST" });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    return { post, calls, settings, leases, clock };
  }

  test("each job runs under its lease with the 200 s budget and answers its summary", async () => {
    expect(INTEL_BUDGET_MS).toBeLessThanOrEqual(200_000);
    expect(INTEL_HARD_STOP_MS).toBeLessThanOrEqual(250_000);
    expect(INTEL_LEASE_MS).toBe(INTEL_BUDGET_MS + 60_000);
    const { post, calls, leases } = intelApp();
    for (const job of ["ingest", "brief", "graph", "watch"] as IntelJob[]) {
      const r = await post(job);
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ job, ok: true, result: { n: 1 } });
      expect(leases.get(job)!.log).toEqual(["acquire", "release"]);
    }
    expect(calls.map((c) => [c.job, c.budgetMs])).toEqual([
      ["ingest", INTEL_BUDGET_MS],
      ["brief", INTEL_BUDGET_MS],
      ["graph", INTEL_BUDGET_MS],
      ["watch", INTEL_BUDGET_MS],
    ]);
  });

  test("a held lease answers 200 skipped and never starts the job", async () => {
    const { post, calls, leases } = intelApp();
    await post("ingest");
    await leases.get("ingest")!.lease.acquire("other", INTEL_LEASE_MS);
    const r = await post("ingest");
    expect(r).toEqual({ status: 200, body: { job: "ingest", ok: true, skipped: "lease held" } });
    expect(calls).toHaveLength(1);
  });

  test("brief self-throttles to INTEL_BRIEF_HOURS (default 6) from the last completed run", async () => {
    const { post, calls, settings, clock } = intelApp();
    expect((await post("brief")).body).toMatchObject({ ok: true });
    expect(settings.get(intelSettingKey("brief"))).toBe(new Date(clock.t).toISOString());
    clock.t += 2 * H;
    expect(await post("brief")).toMatchObject({ status: 200, body: { job: "brief", skipped: "throttled" } });
    clock.t += 4 * H - 60_000; // 6 h minus a minute: within the slack of a 15-minute schedule
    expect((await post("brief")).body).toMatchObject({ ok: true });
    expect(calls.filter((c) => c.job === "brief")).toHaveLength(2);

    const two = intelApp({ env: { INTEL_BRIEF_HOURS: "2" } });
    await two.post("brief");
    two.clock.t += 2 * H;
    expect((await two.post("brief")).body).toMatchObject({ ok: true });
    expect(two.calls).toHaveLength(2);
  });

  test("a failed brief is a 500 and does not stamp the throttle", async () => {
    const { post, calls, settings } = intelApp({ run: { brief: async () => ({ ok: false, complete: false, result: { ok: false, error: "db down" } }) } });
    expect(await post("brief")).toMatchObject({ status: 500, body: { ok: false, result: { error: "db down" } } });
    expect(settings.size).toBe(0);
    await post("brief");
    expect(calls).toHaveLength(2);
  });

  test("graph throttles daily, but an incomplete run (budget ran out) lets the next call continue", async () => {
    let complete = false;
    const { post, calls, clock } = intelApp({ run: { graph: async () => ({ ok: true, complete, result: {} }) } });
    await post("graph");
    clock.t += 15 * 60_000;
    complete = true;
    await post("graph");
    clock.t += 15 * 60_000;
    expect((await post("graph")).body).toMatchObject({ skipped: "throttled" });
    clock.t += 24 * H;
    await post("graph");
    expect(calls).toHaveLength(3);
  });

  test("ingest and watch are not throttled (they are cheap no-ops when nothing is due)", async () => {
    const { post, calls } = intelApp();
    await post("watch");
    await post("watch");
    await post("ingest");
    await post("ingest");
    expect(calls).toHaveLength(4);
  });

  test("a thrown job is a 500 with the error; the lease is still released", async () => {
    const { post, leases } = intelApp({ run: { ingest: () => Promise.reject(new Error("intel tables missing")) } });
    expect(await post("ingest")).toEqual({ status: 500, body: { job: "ingest", ok: false, error: "intel tables missing" } });
    expect(leases.get("ingest")!.log).toEqual(["acquire", "release"]);
  });

  test("a job still running at the hard stop answers, aborts its signal, and releases the lease when it ends", async () => {
    let finish!: () => void;
    let signal!: AbortSignal;
    const { post, leases } = intelApp({
      hardStopMs: 20,
      run: {
        watch: (o) => {
          signal = o.signal;
          return new Promise((r) => (finish = () => r({ ok: true, complete: true, result: {} })));
        },
      },
    });
    expect(await post("watch")).toMatchObject({ status: 500, body: { job: "watch", ok: false, timedOut: true } });
    expect(signal.aborted).toBe(true);
    expect(leases.get("watch")!.log).toEqual(["acquire"]);
    finish();
    await new Promise((r) => setTimeout(r, 0));
    expect(leases.get("watch")!.log).toEqual(["acquire", "release"]);
  });
});
