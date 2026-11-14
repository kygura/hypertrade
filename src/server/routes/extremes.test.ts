import { describe, expect, test } from "bun:test";
import type { ExtremeEvent } from "../../shared/extremes.js";
import type { Alert } from "../desk/notify.js";
import type { PlatformContext } from "../platform/context.js";
import { MemoryPlatformStore } from "../platform/store-memory.js";
import { cronExtremesRoutes, extremesRoutes, freshMid, runExtremesCron, type CronExtremesDeps } from "./extremes.js";

const NOW = new Date("2026-11-14T12:30:00.000Z");
const ev = (coin: string, over: Partial<ExtremeEvent> = {}): ExtremeEvent => ({
  key: `oi_flush|${coin}|long`, kind: "oi_flush", coin, side: "long", ts: "2026-11-14T12:00:00.000Z", window: "4h", mark: 100, severity: 4,
  facts: { oiChg: -0.2 }, line: `${coin} OI -20% in 4h`, ...over,
});

async function setup(mark: number | null = 100) {
  const store = new MemoryPlatformStore();
  await store.insertExtremeEvent({ event: ev("SOL"), delivery: "woken", verdict: null, verdictAt: null });
  await store.insertExtremeEvent({ event: ev("ETH", { ts: "2026-11-01T00:00:00.000Z" }), delivery: "pushed", verdict: null, verdictAt: null });
  const sent: Alert[] = [];
  const marks: string[] = [];
  const app = extremesRoutes({
    store: () => store,
    mark: async (coin) => (marks.push(coin), mark),
    notifier: () => ({ send: async (a) => (sent.push(a), ["ntfy"]) }),
    appUrl: () => "https://app.example",
    now: () => NOW,
  });
  const post = (b: unknown) => app.request("/verdict", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
  return { store, sent, marks, app, post };
}

const take = { key: "oi_flush|SOL|long", stance: "take", direction: "long", killPx: 92, cause: "Liquidation cascade after an exchange outage; no lasting news." };

describe("POST /extremes/verdict", () => {
  test("schema rejects: missing direction or kill on take, unknown stance, extra fields", async () => {
    const { post, store, sent } = await setup();
    for (const b of [{ ...take, killPx: undefined }, { ...take, direction: undefined }, { ...take, stance: "buy" }, { ...take, size: 1 }, { ...take, cause: "" }, "nope"]) {
      expect((await post(b)).status).toBe(400);
    }
    expect((await store.latestExtreme("oi_flush|SOL|long"))!.verdict).toBeNull();
    expect(sent).toEqual([]);
  });

  test("unknown key 404, already answered 409", async () => {
    const { post } = await setup();
    expect((await post({ ...take, key: "oi_flush|NOPE|long" })).status).toBe(404);
    expect((await post(take)).status).toBe(200);
    expect((await post({ ...take, stance: "pass" })).status).toBe(409);
  });

  test("take with the kill on the wrong side of the mark: 422, nothing stored or pushed", async () => {
    const { post, store, sent } = await setup(100);
    const long = await post({ ...take, killPx: 101 });
    expect(long.status).toBe(422);
    expect(await long.json()).toMatchObject({ field: "killPx", mark: 100 });
    expect((await post({ ...take, direction: "short", killPx: 99 })).status).toBe(422);
    expect((await post({ ...take, killPx: 100 })).status).toBe(422);
    expect((await store.latestExtreme("oi_flush|SOL|long"))!.verdict).toBeNull();
    expect(sent).toEqual([]);
  });

  test("take without a fresh mark: 503, nothing stored", async () => {
    const { post, store } = await setup(null);
    expect((await post(take)).status).toBe(503);
    expect((await store.latestExtreme("oi_flush|SOL|long"))!.verdict).toBeNull();
  });

  test("take: stamps the mark, stores the verdict and pushes exactly once", async () => {
    const { post, store, sent, marks } = await setup(100);
    const res = await post(take);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mark: number; pushed: string[]; record: { verdictAt: string } };
    expect(body).toMatchObject({ mark: 100, pushed: ["ntfy"], record: { verdictAt: NOW.toISOString() } });
    expect(marks).toEqual(["SOL"]);
    expect((await store.latestExtreme("oi_flush|SOL|long"))!.verdict).toEqual({ ...take, sources: [] } as never);
    expect(sent).toEqual([{
      level: "warn", title: "Take: long SOL", click: "https://app.example/coin/SOL",
      body: "SOL OI -20% in 4h\nLiquidation cascade after an exchange outage; no lasting news.\nKill 92 (mark 100)",
    }]);
    expect((await post(take)).status).toBe(409);
    expect(sent.length).toBe(1);
  });

  test("watch and pass: stored, no mark read, no push", async () => {
    for (const stance of ["watch", "pass"]) {
      const { post, store, sent, marks } = await setup();
      const res = await post({ key: "oi_flush|SOL|long", stance, cause: "Token unlock priced in." });
      expect(res.status).toBe(200);
      expect((await store.latestExtreme("oi_flush|SOL|long"))!.verdict?.stance).toBe(stance as never);
      expect(sent).toEqual([]);
      expect(marks).toEqual([]);
    }
  });
});

describe("GET /extremes", () => {
  test("lists records in the last `days`, newest first; rejects a bad days", async () => {
    const { app } = await setup();
    const week = (await (await app.request("/?days=7")).json()) as { records: { event: { coin: string } }[] };
    expect(week.records.map((r) => r.event.coin)).toEqual(["SOL"]);
    const month = (await (await app.request("/?days=30")).json()) as { records: { event: { coin: string } }[] };
    expect(month.records.map((r) => r.event.coin)).toEqual(["SOL", "ETH"]);
    expect((await app.request("/?days=0")).status).toBe(400);
    expect((await app.request("/?days=7&x=1")).status).toBe(400);
  });
});

describe("POST /cron/extremes", () => {
  const lease = (free = true) => ({ acquire: async () => free, release: async () => {} });
  const job = (): ReturnType<CronExtremesDeps["job"]> => ({
    store: new MemoryPlatformStore(), detect: () => [], lookbackMs: 1, wake: async () => false, notifier: { send: async () => [] }, appUrl: null, now: () => NOW.getTime(),
  });

  test("503 without a database, skipped when leased, counts otherwise", async () => {
    expect((await runExtremesCron({ hasDb: () => false, lease: lease(), job })).status).toBe(503);
    expect(await runExtremesCron({ hasDb: () => true, lease: lease(false), job })).toEqual({ status: 200, body: { ok: true, skipped: "leased" } });
    const r = await runExtremesCron({ hasDb: () => true, lease: lease(), job });
    expect(r).toEqual({ status: 200, body: { ok: true, coins: 0, evaluated: 0, fired: 0, new: 0, woken: 0, pushed: 0, capped: 0, undelivered: 0, lines: [] } });
  });

  test("a failing job is a 500 body; the route needs the cron token", async () => {
    const bad = () => ({ ...job(), store: { ...new MemoryPlatformStore(), scanSnapshotsSince: async () => { throw new Error("db down"); } } as never });
    expect(await runExtremesCron({ hasDb: () => true, lease: lease(), job: bad })).toEqual({ status: 500, body: { ok: false, error: "db down" } });
    process.env.CRON_TOKEN ??= "extremes-test-token";
    const app = cronExtremesRoutes(() => ({ hasDb: () => false, lease: lease(), job }));
    expect((await app.request("/extremes", { method: "POST" })).status).toBe(401);
    expect((await app.request("/extremes", { method: "POST", headers: { "x-cron-token": process.env.CRON_TOKEN! } })).status).toBe(503);
  });
});

describe("freshMid", () => {
  const ctx = (age: number | null, mid: number | null): PlatformContext => ({
    store: new MemoryPlatformStore(), midAge: () => age, mid: () => mid, lastScanAt: async () => null, nearMisses: async () => [], scanIntervalSec: 60, refreshMids: async () => {},
  });
  test("the mid only while it is fresh (the approval gate's age limit)", async () => {
    expect(await freshMid(ctx(2, 101), "SOL", 0)).toBe(101);
    expect(await freshMid(ctx(31, 101), "SOL", 0)).toBeNull();
    expect(await freshMid(ctx(null, 101), "SOL", 0)).toBeNull();
    expect(await freshMid(ctx(2, null), "SOL", 0)).toBeNull();
  });
});
