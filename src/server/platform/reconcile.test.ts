import { describe, expect, test } from "bun:test";
import type { LedgerPayload } from "../../shared/platform.js";
import { makeService } from "../desk/testkit.js";
import type { AccountState, Position } from "../desk/types.js";
import { placedBy, placing } from "./context.js";
import { createReconcileLoop, reconcileOnce, type ReconcileDesk } from "./reconcile.js";
import { MemoryPlatformStore } from "./store-memory.js";

const created: LedgerPayload<"created"> = { features: { features: {}, inputs: {} }, market: {}, score: 1, scoreVersion: "v1" };
const seen = { score: 1, scoreVersion: "v1", features: created.features, stopPx: 3800, targetPx: 4500, invalidationPx: 3800, regime: "r", liquidityTier: 1 as const, costs: null };
const approve: LedgerPayload<"decision"> = { decision: "approve", reason: null, operator: "operator", seen };
const order = { coin: "ETH", side: "long" as const, stop: 3800, target: 4500, notionalUsd: 800, source: "copilot" as const };

function setup() {
  const store = new MemoryPlatformStore();
  const kit = makeService();
  let now = new Date(kit.service.now().getTime() + 3 * 60_000);
  const deps = { store, desk: (): ReconcileDesk => kit.service, now: () => now };
  /** An approved ETH long whose status moved `ageMin` minutes before `now`. */
  const approved = async (ageMin = 3, coin = "ETH", setupKind = "breakout") => {
    const { opportunity: o } = await store.upsertOpportunity(
      { coin, direction: "long", setupKind, tradeType: "directional", score: 1, scoreVersion: "v1", tags: [], liquidityTier: 1, regime: "r", invalidation: "x", entryPx: 4000, stopPx: 3800, targetPx: 4500, invalidationPx: 3800 },
      created,
    );
    for (const [f, t] of [["new", "calculated"], ["calculated", "ready"]] as const) await store.transitionOpportunity(o.id, f, t, "system");
    await store.transitionOpportunity(o.id, "ready", "approved", "operator", approve);
    store.opportunities.get(o.id)!.statusChangedAt = new Date(now.getTime() - ageMin * 60_000).toISOString();
    return o.id;
  };
  return { store, kit, deps, approved, advance: (min: number) => (now = new Date(now.getTime() + min * 60_000)) };
}

describe("reconcile", () => {
  test("stuck approved with an executed desk proposal → open with its ref; a fresh one is left alone", async () => {
    const { store, kit, deps, approved } = setup();
    const stuck = await approved(3);
    const fresh = await approved(1, "BTC");
    const rec = await kit.service.placeOperatorOrder(order, placedBy(stuck));
    expect(await reconcileOnce(deps)).toEqual([{ id: stuck, to: "open" }]);
    expect((await store.getOpportunity(fresh))?.status).toBe("approved");
    expect((await store.ledgerFor(stuck)).at(-1)!.payload).toEqual({ from: "approved", to: "open", actor: "system", ref: rec.id, reason: "reconciled: desk proposal executed" });
  });

  test("D3: two approvals on the same coin and side seconds apart each get their own proposal", async () => {
    const { store, kit, deps, approved } = setup();
    const a = await approved(3, "ETH", "breakout");
    const b = await approved(3, "ETH", "squeeze");
    await kit.service.setKillSwitch(true, "test", "test");
    const ra = await kit.service.placeOperatorOrder(order, placedBy(a)); // blocked
    await kit.service.setKillSwitch(false, "test", "test");
    const rb = await kit.service.placeOperatorOrder(order, placedBy(b)); // executed
    expect([ra.status, rb.status]).toEqual(["blocked", "executed"]);
    expect((await reconcileOnce(deps)).sort((x, y) => x.to.localeCompare(y.to))).toEqual([{ id: a, to: "failed" }, { id: b, to: "open" }]);
    expect((await store.ledgerFor(a)).at(-1)!.payload).toMatchObject({ ref: ra.id, reason: "reconciled: desk proposal blocked" });
    expect((await store.ledgerFor(b)).at(-1)!.payload).toMatchObject({ ref: rb.id });
  });

  test("D1: no proposal yet → left approved until the placement bound, then failed; an in-flight id is never touched", async () => {
    const { store, deps, approved, advance } = setup();
    const none = await approved(3);
    const busy = await approved(3, "BTC");
    placing.add(busy);
    try {
      expect(await reconcileOnce(deps)).toEqual([]);
      advance(8);
      expect(await reconcileOnce(deps)).toEqual([{ id: none, to: "failed" }]);
      expect((await store.getOpportunity(busy))?.status).toBe("approved");
    } finally {
      placing.delete(busy);
    }
    expect((await store.ledgerFor(none)).at(-1)!.payload).toMatchObject({ to: "failed", actor: "system", ref: null, reason: "reconciled: no desk proposal" });
  });

  test("D5: a proposal stuck pending → one alert after 10 min, row stays approved", async () => {
    const { store, kit, deps, approved, advance } = setup();
    const id = await approved(3);
    const rec = await kit.store.insertProposal({ runId: null, kind: "open", venue: "paper", proposal: order as never, verdict: { approved: true, reasons: [], warnings: [] } as never, execution: null, status: "pending", expiresAt: null, decidedBy: placedBy(id) });
    const loop = createReconcileLoop(deps);
    await loop.run();
    advance(8);
    await loop.run();
    await loop.run();
    expect(kit.notifier.sent.filter((a) => a.title.startsWith("Approval stuck"))).toHaveLength(1);
    expect(kit.notifier.sent.at(-1)!.body).toContain(rec.id);
    expect((await store.getOpportunity(id))?.status).toBe("approved");
  });

  test("open whose paper position is gone → closed; still held → unchanged", async () => {
    const { store, kit, deps, approved } = setup();
    const id = await approved(3);
    const rec = await kit.service.placeOperatorOrder(order, placedBy(id));
    await store.transitionOpportunity(id, "approved", "open", "system", undefined, { ref: rec.id });
    expect(await reconcileOnce(deps)).toEqual([]);
    await kit.store.deletePaperPosition("ETH");
    const log = console.log;
    console.log = () => {};
    const loop = createReconcileLoop(deps);
    expect([loop.name, loop.intervalSec]).toEqual(["reconcile", 60]);
    await loop.run();
    console.log = log;
    expect((await store.getOpportunity(id))?.status).toBe("closed");
    expect((await store.ledgerFor(id)).at(-1)!.payload).toEqual({ from: "open", to: "closed", actor: "system", ref: rec.id, reason: "reconciled: desk position closed" });
    expect(await store.lastTerminalAt("ETH|long|breakout")).toBeInstanceOf(Date);
  });

  test("D2 live: open only while the venue position is this proposal's fill; another ETH long ⇒ closed", async () => {
    const { store, kit, deps, approved } = setup();
    const id = await approved(3);
    const rec = await kit.service.placeOperatorOrder(order, placedBy(id));
    await store.transitionOpportunity(id, "approved", "open", "system", undefined, { ref: rec.id });
    const fill = (rec.execution as { fills: Array<{ size: number; px: number }> }).fills[0]!;
    let positions: Position[] = [{ coin: "ETH", side: "long", size: fill.size, entryPx: fill.px, markPx: fill.px, stopPx: null, tpPx: null, unrealizedPnl: 0, notionalUsd: 800 }];
    const live: ReconcileDesk = {
      store: kit.store, broker: { live: true }, alert: async () => {},
      account: async (): Promise<AccountState> => ({ venue: "hl-testnet", equityUsd: 1, dayPnlUsd: 0, positions, available: true }),
    };
    const d = { ...deps, desk: () => live };
    expect(await reconcileOnce(d)).toEqual([]);
    positions = [{ ...positions[0]!, size: fill.size * 3, entryPx: fill.px * 1.01 }]; // someone else's ETH long
    expect(await reconcileOnce(d)).toEqual([{ id, to: "closed" }]);
  });
});
