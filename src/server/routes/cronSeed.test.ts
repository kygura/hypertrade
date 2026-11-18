import { describe, expect, test } from "bun:test";
import { MemoryPlatformStore } from "../platform/store-memory.js";
import { SEED_DEADLINE, type SnapshotSeedDeps } from "../platform/seed.js";
import type { LabLease } from "./cron.js";
import { runSeedCron, type CronSeedDeps } from "./cronSeed.js";

const NOW = Date.UTC(2026, 10, 18, 12, 6);
const free: LabLease = { acquire: async () => true, release: async () => {} };

/** A seed whose every coin fails in `oi` with `error`, or has nothing to fill when `error` is null. */
function deps(over: Partial<CronSeedDeps> = {}, seed: Partial<SnapshotSeedDeps> = {}): CronSeedDeps & { asked: number[] } {
  const asked: number[] = [];
  return {
    asked, hasDb: () => true, hasKey: () => true, lease: free, now: () => NOW,
    seed: ({ deadline, days }) => (asked.push(days), {
      coins: async () => ["SOL", "ETH"], candles: async () => [], funding: async () => [], oi: async () => new Map(),
      store: new MemoryPlatformStore(), now: () => NOW, dryRun: false, deadline, days, ...seed,
    }),
    ...over,
  };
}

describe("runSeedCron", () => {
  test("no database is 503; no Coinalyze key or a held lease is a skip, not a failure", async () => {
    expect((await runSeedCron(deps({ hasDb: () => false }))).status).toBe(503);
    expect(await runSeedCron(deps({ hasKey: () => false }))).toEqual({ status: 200, body: { ok: true, skipped: "no COINALYZE_API_KEY" } });
    expect(await runSeedCron(deps({ lease: { ...free, acquire: async () => false } }))).toEqual({ status: 200, body: { ok: true, skipped: "leased" } });
  });

  test("passes the window through and reports each coin's reason; every needed coin failing is a 500", async () => {
    const d = deps();
    const r = await runSeedCron(d, 14);
    expect(d.asked).toEqual([14]);
    expect(r.status).toBe(500);
    expect(r.body).toMatchObject({ ok: false, error: "no coin seeded: SOL: Coinalyze returned no OI bars" });
  });

  test("coins cut by the deadline are `remaining` and the run is ok", async () => {
    const r = await runSeedCron(deps({}, { deadline: NOW }));
    expect(r).toEqual({ status: 200, body: { ok: true, coins: 2, written: 0, skipped: [], remaining: ["SOL", "ETH"] } });
    expect(SEED_DEADLINE).toBe("not started before the deadline");
  });
});
