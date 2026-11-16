import { describe, expect, test } from "bun:test";
import { migrate } from "../../../db/migrate.js";
import type { DeskPlanInput, PlanMetrics } from "../../shared/deskPlan.js";
import { newPglite, pgliteDb, pgliteSql } from "../testing/pglite.js";
import { loadDeskConfig } from "./config.js";
import { COOLDOWN_KEY } from "./cooldown.js";
import { DeskService } from "./service.js";
import { MemoryStore, PgStore, type DeskStore, type NewPlan } from "./store.js";
import { FakeData, RecordingNotifier, ctx } from "./testkit.js";

// Store parity for the plan journal and the cooldown's key/value state: one suite against MemoryStore and PgStore
// (030_desk_plans.sql on PGlite, applied by db/migrate.ts).

const input: DeskPlanInput = { coin: "ETH", side: "long", rungs: [{ px: 4000, size: 0.1 }], stopPx: 3800, targetPx: 4400, note: "breakout retest" };
const metrics: PlanMetrics = {
  totalSize: 0.1, notionalUsd: 400, avgEntryPx: 4000, topRungPx: 4000, lossAtStopUsd: 20, lossAtStopPct: 0.2,
  rrFull: 2, rrTopOnly: 2, dailyLimitUsedPct: 10, drawdownUsedPct: 2, equityUsd: 10_000, markPx: 4000,
};
const plan = (over: Partial<NewPlan> = {}): NewPlan => ({
  createdAt: "2026-10-05T12:00:00.000Z", source: "plan", venue: "paper", input, metrics, blockers: [], warnings: ["w"], placed: false, placement: null, ...over,
});

let pglite: Promise<ReturnType<typeof newPglite>> | null = null;
async function pgStore(): Promise<DeskStore> {
  // One migrated database for the suite (migrations take seconds); each test starts from empty tables.
  pglite ??= (async () => {
    const pg = newPglite();
    await migrate(pgliteDb(pg), () => {});
    return pg;
  })();
  const pg = await pglite;
  await pg.exec("delete from desk_plans; delete from desk_state;");
  const q = pgliteSql(pg);
  return new PgStore(() => q);
}

function storesPlans(name: string, make: () => Promise<DeskStore>) {
  describe(`${name}: plan journal`, () => {
    test("insert, get, update placement, list newest first", async () => {
      const s = await make();
      const a = await s.insertPlan(plan());
      const b = await s.insertPlan(plan({ createdAt: "2026-10-05T12:00:00.000Z", blockers: ["no target: every plan needs one"], input: { ...input, targetPx: null } }));
      const c = await s.insertPlan(plan({ createdAt: "2026-10-05T13:00:00.000Z", source: "copilot", venue: "propr" }));
      expect(typeof a.id).toBe("string");
      expect({ ...a, id: "x" }).toEqual({ ...plan(), id: "x" });
      expect(a.input.note).toBe("breakout retest");
      expect(await s.getPlan(b.id)).toEqual(b);
      expect(b.input.targetPx).toBeNull();
      // Same createdAt: the later insert lists first.
      expect((await s.listPlans(10)).map((x) => x.id)).toEqual([c.id, b.id, a.id]);
      expect(await s.listPlans(1)).toHaveLength(1);

      const placement = { proposalId: "00000000-0000-4000-8000-00000000abcd", status: "executed" as const, error: null, dryRun: false, note: "oid 1" };
      const up = await s.updatePlan(a.id, { placed: true, placement });
      expect(up).toEqual({ ...a, placed: true, placement });
      expect(await s.getPlan(a.id)).toEqual(up);
      expect(await s.updatePlan("00000000-0000-4000-8000-000000000999", { placed: true, placement })).toBeNull();
      expect(await s.getPlan("00000000-0000-4000-8000-000000000999")).toBeNull();
    });

    test("a cooldown written through the KV state survives a fresh service on the same store", async () => {
      const store = await make();
      const now = () => new Date("2026-10-05T12:00:00Z");
      const svc = () => new DeskService({ config: loadDeskConfig({}), store, data: new FakeData([ctx("ETH", 4000)]), notifier: new RecordingNotifier(), now });
      await svc().recordStopOut("ETH", new Date("2026-10-05T11:00:00Z"), { source: "paper", proposalId: null, fill: { side: "long", size: 0.1, px: 3800, pnl: -20 } });
      expect(await store.getState(COOLDOWN_KEY)).toMatchObject({ stopOuts: [{ coin: "ETH", at: "2026-10-05T11:00:00.000Z" }] });
      const locks = await svc().locks();
      expect(locks.coins).toMatchObject([{ coin: "ETH", until: "2026-10-05T15:00:00.000Z", ref: { fill: { pnl: -20 }, planId: null } }]);
    });
  });
}

storesPlans("MemoryStore", async () => new MemoryStore());
storesPlans("PgStore (PGlite)", pgStore);
