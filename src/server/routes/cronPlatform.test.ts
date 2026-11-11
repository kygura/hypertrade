import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { Info } from "../platform/scanner.js";
import { MemoryPlatformStore } from "../platform/store-memory.js";
import { cronPlatformRoutes, PLATFORM_TICK_LEASE_MS, runPlatformTickJob, type CronPlatformDeps } from "./cronPlatform.js";

process.env.CRON_TOKEN = "test-cron-token";

const NOW = Date.UTC(2026, 9, 20, 12);
const ctx = (mark: number) => ({
  funding: "0.00001", openInterest: String(1e8 / mark), prevDayPx: String(mark), dayNtlVlm: "500000000", premium: "0", oraclePx: String(mark), markPx: String(mark), midPx: String(mark), impactPxs: null, dayBaseVlm: "1",
});
const infoOf = (coins: string[]) =>
  (async () => [{ universe: coins.map((name) => ({ name, szDecimals: 3, maxLeverage: 20 })) }, coins.map(() => ctx(100))]) as unknown as Info;

function deps(over: Partial<CronPlatformDeps> & { info?: Info; novelty?: () => { tick: () => Promise<void> } } = {}) {
  const store = new MemoryPlatformStore();
  const lease = { held: false, acquired: [] as number[], released: 0 };
  let novelty = 0;
  const d: CronPlatformDeps = {
    hasDb: () => true,
    lease: {
      acquire: async (_h, ttl) => (lease.acquired.push(ttl), !lease.held),
      release: async () => void lease.released++,
    },
    tick: () => ({
      store, info: over.info ?? infoOf(["A", "B"]), candles: async () => [], log: () => {}, logError: () => {},
      novelty: () => (novelty++, { tick: async () => {} }),
    }),
    now: () => NOW,
    ...over,
  };
  return { d, store, lease, novelty: () => novelty };
}
const post = (d: CronPlatformDeps, headers: Record<string, string> = { "x-cron-token": "test-cron-token" }) =>
  new Hono().route("/cron", cronPlatformRoutes(() => d)).request("/cron/platform-tick", { method: "POST", headers });

describe("POST /cron/platform-tick", () => {
  test("401 without a cron token or with a wrong one; nothing runs", async () => {
    const x = deps();
    expect((await post(x.d, {})).status).toBe(401);
    expect((await post(x.d, { "x-cron-token": "wrong" })).status).toBe(401);
    expect(x.lease.acquired).toEqual([]);
  });

  test("Vercel's Authorization: Bearer $CRON_SECRET is accepted, as on the other cron routes", async () => {
    process.env.CRON_SECRET = "test-cron-secret";
    try {
      expect((await post(deps().d, { authorization: "Bearer test-cron-secret" })).status).toBe(200);
    } finally {
      delete process.env.CRON_SECRET;
    }
  });

  test("no database: 503 with a reason, lease untouched", async () => {
    const x = deps({ hasDb: () => false });
    const res = await post(x.d);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toContain("DATABASE_URL");
    expect(x.lease.acquired).toEqual([]);
  });

  test("lease held: 200 skipped, nothing written", async () => {
    const x = deps();
    x.lease.held = true;
    const res = await post(x.d);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, skipped: "leased" });
    expect(await x.store.scanSnapshotsSince(new Date(0).toISOString())).toEqual([]);
    expect(x.lease.released).toBe(0);
  });

  test("a tick writes snapshots, reports counts, never runs novelty and releases the lease", async () => {
    const x = deps();
    const res = await post(x.d);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.ok).toBe(true);
    expect(body.snapshotRows).toBe(2);
    expect(body.candidates).toBe(0);
    expect(body.opportunities).toEqual({ upserted: 0, created: 0 });
    expect(body.steps.map((s: { name: string; status: string }) => `${s.name}:${s.status}`)).toEqual(["scanner:ok", "novelty:skipped", "outcomes:ok", "prune:ok"]);
    expect(body.steps[1].reason).toContain("excluded");
    expect(typeof body.ms).toBe("number");
    expect(x.novelty()).toBe(0);
    expect((await x.store.scanSnapshotsSince(new Date(NOW - 60_000).toISOString())).length).toBe(2);
    expect(x.lease.acquired).toEqual([PLATFORM_TICK_LEASE_MS]);
    expect(x.lease.released).toBe(1);
  });

  test("deadline reached during the scan: outcomes and prune reported skipped with a reason", async () => {
    let t = NOW;
    const inner = infoOf(["A"]);
    const info = (async (b: unknown) => ((t += 250_000), (inner as any)(b))) as Info;
    const x = deps({ info, now: () => t, budgetMs: 200_000 });
    const res = await post(x.d);
    const body = (await res.json()) as Record<string, any>;
    expect(res.status).toBe(200);
    expect(body.steps.map((s: { name: string; status: string }) => `${s.name}:${s.status}`)).toEqual(["scanner:ok", "novelty:skipped", "outcomes:skipped", "prune:skipped"]);
    expect(body.steps[2].reason).toMatch(/^deadline: 0 ms left/);
  });

  test("a failed step answers 500 with the step named", async () => {
    const x = deps({ info: (async () => Promise.reject(new Error("HL down"))) as Info });
    const res = await post(x.d);
    expect(res.status).toBe(500);
    expect(((await res.json()) as { failed: string[] }).failed).toEqual(["scanner"]);
  });
});

describe("runPlatformTickJob", () => {
  test("hard stop: a hung step still gets an answer naming it", async () => {
    const x = deps({ info: (() => new Promise(() => {})) as Info, hardStopMs: 20 });
    const r = await runPlatformTickJob(x.d);
    expect(r.status).toBe(500);
    expect(r.body).toMatchObject({ ok: false, timedOut: true, error: "still running after 0s: scanner" });
  });

  test("a lease error is a 500 body, not a throw", async () => {
    const x = deps();
    x.d.lease.acquire = async () => Promise.reject(new Error("db down"));
    expect(await runPlatformTickJob(x.d)).toEqual({ status: 500, body: { ok: false, error: "lease: db down" } });
  });
});
