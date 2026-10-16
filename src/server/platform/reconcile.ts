import type { LedgerEntry, Opportunity } from "../../shared/platform.js";
import type { Broker } from "../desk/paper.js";
import type { DeskStore } from "../desk/store.js";
import type { AccountState, OperatorOrderRecord, ProposalRecord } from "../desk/types.js";
import type { LoopDef } from "./runtime.js";
import type { PlatformStore } from "./store.js";

// Reconcile loop (SPEC P0.11 gate amendment): settles opportunities against the desk.
//   approved for over 2 min → its desk proposal decides: executed → open (ref), anything final → failed (system).
//   open whose desk position is gone → closed (system). Frees the dedupe slot; the cooldown measures from it.
//
// Deps (scripts/server.ts passes `{ store, desk: defaultDeskService, now: () => new Date() }`):
//   store: PlatformStore
//   desk:  () => ReconcileDesk — a DeskService satisfies it (resolved per run, like routes/desk.ts defaultDeskService)
//   now:   () => Date

export interface ReconcileDesk {
  readonly store: Pick<DeskStore, "getProposal" | "listProposals" | "paperPositions">;
  readonly broker: Pick<Broker, "live">;
  account(): Promise<AccountState>;
}
export interface ReconcileDeps {
  store: PlatformStore;
  desk: () => ReconcileDesk;
  now: () => Date;
}

export const STUCK_APPROVED_MS = 2 * 60_000;
/** Store clocks differ (pg now() vs JS): a proposal this much older than the decision still matches it. */
const CLOCK_SLACK_MS = 5_000;
const ROWS = 500;

type StatusEntry = Extract<LedgerEntry, { kind: "status" }>;
const lastRef = (entries: LedgerEntry[]) =>
  entries.filter((e): e is StatusEntry => e.kind === "status" && typeof e.payload.ref === "string").at(-1)?.payload.ref ?? null;

/**
 * The approve route's desk proposal: by a recorded ref, else the earliest copilot open for the same coin and side
 * created since the approve decision. ponytail: heuristic match without a ref; carry the opportunity id on the
 * desk proposal if two approvals on one coin within seconds ever happen.
 */
async function proposalFor(desk: ReconcileDesk, o: Opportunity, entries: LedgerEntry[]): Promise<ProposalRecord | null> {
  const ref = lastRef(entries);
  if (ref) return desk.store.getProposal(ref);
  const decided = entries.find((e) => e.kind === "decision" && e.payload.decision === "approve");
  if (!decided) return null;
  const since = Date.parse(decided.createdAt) - CLOCK_SLACK_MS;
  return (await desk.store.listProposals({ limit: 100 }))
    .filter((p) => {
      const q = p.proposal as Partial<OperatorOrderRecord>;
      return p.kind === "open" && q.source === "copilot" && q.coin?.toLowerCase() === o.coin.toLowerCase() && q.side === o.direction && Date.parse(p.createdAt) >= since;
    })
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0] ?? null;
}

/** null when the venue cannot be read this run. */
async function positionOpen(desk: ReconcileDesk, o: Opportunity, ref: string): Promise<boolean | null> {
  if (!desk.broker.live) return (await desk.store.paperPositions()).some((p) => p.proposalId === ref);
  const a = await desk.account();
  return a.available ? a.positions.some((p) => p.coin.toLowerCase() === o.coin.toLowerCase() && p.side === o.direction) : null;
}

/** One pass. Returns the moves made (for tests and logs). */
export async function reconcileOnce({ store, desk: getDesk, now }: ReconcileDeps): Promise<Array<{ id: string; to: "open" | "failed" | "closed" }>> {
  const desk = getDesk();
  const moved: Array<{ id: string; to: "open" | "failed" | "closed" }> = [];
  const t = now().getTime();
  for (const o of await store.listOpportunities({ statuses: ["approved", "open"], limit: ROWS })) {
    const entries = await store.ledgerFor(o.id);
    if (o.status === "approved") {
      if (t - Date.parse(o.statusChangedAt) < STUCK_APPROVED_MS) continue;
      const p = await proposalFor(desk, o, entries);
      if (p?.status === "pending") continue; // still in flight at the desk
      const to = p?.status === "executed" ? "open" : "failed";
      const r = await store.transitionOpportunity(o.id, "approved", to, "system", undefined, { ref: p?.id ?? null, reason: `reconciled: ${p ? `desk proposal ${p.status}` : "no desk proposal"}` });
      if (r) moved.push({ id: o.id, to });
    } else {
      const ref = lastRef(entries);
      if (!ref || (await positionOpen(desk, o, ref)) !== false) continue;
      const r = await store.transitionOpportunity(o.id, "open", "closed", "system", undefined, { ref, reason: "reconciled: desk position closed" });
      if (r) moved.push({ id: o.id, to: "closed" });
    }
  }
  return moved;
}

export function createReconcileLoop(deps: ReconcileDeps): LoopDef {
  return {
    name: "reconcile",
    intervalSec: 60,
    run: async () => {
      for (const m of await reconcileOnce(deps)) console.log(deps.now().toISOString(), "[reconcile]", m.id, "→", m.to);
    },
  };
}
