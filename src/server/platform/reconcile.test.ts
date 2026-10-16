import { describe, expect, test } from "bun:test";
import type { LedgerPayload } from "../../shared/platform.js";
import { makeService } from "../desk/testkit.js";
import { createReconcileLoop, reconcileOnce } from "./reconcile.js";
import { MemoryPlatformStore } from "./store-memory.js";

const created: LedgerPayload<"created"> = { features: { features: {}, inputs: {} }, market: {}, score: 1, scoreVersion: "v1" };
const seen = { score: 1, scoreVersion: "v1", features: created.features, stopPx: 3800, targetPx: 4500, invalidationPx: 3800, regime: "r", liquidityTier: 1 as const, costs: null };
const approve: LedgerPayload<"decision"> = { decision: "approve", reason: null, operator: "operator", seen };

async function setup() {
  const store = new MemoryPlatformStore();
  const kit = makeService();
  const now = new Date(kit.service.now().getTime() + 3 * 60_000);
  const deps = { store, desk: () => kit.service, now: () => now };
  /** An approved ETH long whose status moved `ageMin` minutes before `now`. */
  const approved = async (ageMin = 3, coin = "ETH") => {
    const { opportunity: o } = await store.upsertOpportunity(
      { coin, direction: "long", setupKind: "breakout", tradeType: "directional", score: 1, scoreVersion: "v1", tags: [], liquidityTier: 1, regime: "r", invalidation: "x", entryPx: 4000, stopPx: 3800, targetPx: 4500, invalidationPx: 3800 },
      created,
    );
    for (const [f, t] of [["new", "calculated"], ["calculated", "ready"]] as const) await store.transitionOpportunity(o.id, f, t, "system");
    await store.transitionOpportunity(o.id, "ready", "approved", "operator", approve);
    store.opportunities.get(o.id)!.statusChangedAt = new Date(now.getTime() - ageMin * 60_000).toISOString();
    // The approve decision was written at real time; place it at the desk clock so the proposal matches it.
    for (const e of store.ledger) if (e.opportunityId === o.id) (e as { createdAt: string }).createdAt = kit.service.now().toISOString();
    return o.id;
  };
  const order = { coin: "ETH", side: "long" as const, stop: 3800, target: 4500, notionalUsd: 800, source: "copilot" as const };
  return { store, kit, deps, approved, order };
}

describe("reconcile", () => {
  test("stuck approved with an executed desk proposal → open with its ref; a fresh one is left alone", async () => {
    const { store, kit, deps, approved, order } = await setup();
    const stuck = await approved(3);
    const fresh = await approved(1, "BTC");
    const rec = await kit.service.placeOperatorOrder(order, "operator");
    expect(await reconcileOnce(deps)).toEqual([{ id: stuck, to: "open" }]);
    expect((await store.getOpportunity(fresh))?.status).toBe("approved");
    expect((await store.ledgerFor(stuck)).at(-1)!.payload).toEqual({ from: "approved", to: "open", actor: "system", ref: rec.id, reason: "reconciled: desk proposal executed" });
  });

  test("stuck approved with no desk proposal, or a blocked one → failed", async () => {
    const { store, kit, deps, approved, order } = await setup();
    const none = await approved(3);
    expect(await reconcileOnce(deps)).toEqual([{ id: none, to: "failed" }]);
    expect((await store.ledgerFor(none)).at(-1)!.payload).toMatchObject({ to: "failed", actor: "system", ref: null, reason: "reconciled: no desk proposal" });

    await kit.service.setKillSwitch(true, "test", "test");
    const blocked = await approved(3, "SOL");
    const rec = await kit.service.placeOperatorOrder({ ...order, coin: "SOL", stop: 190, target: 230 }, "operator");
    expect(rec.status).toBe("blocked");
    expect(await reconcileOnce(deps)).toEqual([{ id: blocked, to: "failed" }]);
    expect((await store.ledgerFor(blocked)).at(-1)!.payload).toMatchObject({ ref: rec.id, reason: "reconciled: desk proposal blocked" });
  });

  test("open whose paper position is gone → closed; still held → unchanged", async () => {
    const { store, kit, deps, approved, order } = await setup();
    const id = await approved(3);
    const rec = await kit.service.placeOperatorOrder(order, "operator");
    await store.transitionOpportunity(id, "approved", "open", "system", undefined, { ref: rec.id });
    expect(await reconcileOnce(deps)).toEqual([]);
    await kit.store.deletePaperPosition("ETH");
    const loop = createReconcileLoop(deps);
    expect([loop.name, loop.intervalSec]).toEqual(["reconcile", 60]);
    const log = console.log;
    console.log = () => {};
    await loop.run();
    console.log = log;
    expect((await store.getOpportunity(id))?.status).toBe("closed");
    expect((await store.ledgerFor(id)).at(-1)!.payload).toEqual({ from: "open", to: "closed", actor: "system", ref: rec.id, reason: "reconciled: desk position closed" });
    expect(await store.lastTerminalAt("ETH|long|breakout")).toBeInstanceOf(Date);
  });
});
