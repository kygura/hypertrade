import type { LedgerEntry, Opportunity } from "../../shared/platform.js";
import type { Broker, ExecutionResult } from "../desk/paper.js";
import type { DeskStore } from "../desk/store.js";
import type { AlertLevel, AccountState, ProposalRecord } from "../desk/types.js";
import { placedBy, placing } from "./context.js";
import type { LoopDef } from "./runtime.js";
import type { PlatformStore } from "./store.js";

// Reconcile loop (SPEC P0.11 gate amendment): settles opportunities against the desk.
//   approved for over 2 min, not placing in this process (context.ts `placing`) → its desk proposal decides:
//     executed → open (ref); blocked/failed/rejected/expired → failed (system);
//     pending → left approved, one desk alert after 10 min; none at all → failed only after 10 min.
//   open whose desk position is gone → closed (system). Frees the dedupe slot; the cooldown measures from it.
// The proposal is found by the status entry's ref, else by the opportunity id the approve route stamps on its
// decidedBy (context.ts placedBy). There is no coin/side guess.
//
// Deps (scripts/server.ts passes `{ store, desk: defaultDeskService, now: () => new Date() }`):
//   store: PlatformStore
//   desk:  () => ReconcileDesk — a DeskService satisfies it (resolved per run, like routes/desk.ts defaultDeskService)
//   now:   () => Date

export interface ReconcileDesk {
  readonly store: Pick<DeskStore, "getProposal" | "listProposals" | "paperPositions">;
  readonly broker: Pick<Broker, "live">;
  account(): Promise<AccountState>;
  alert(level: AlertLevel, title: string, body: string): Promise<void>;
}
export interface ReconcileDeps {
  store: PlatformStore;
  desk: () => ReconcileDesk;
  now: () => Date;
}

export const STUCK_APPROVED_MS = 2 * 60_000;
/** Longer than any placement (preview TTL 60 s plus venue round trips): only then is "no proposal" final. */
export const PLACEMENT_BOUND_MS = 10 * 60_000;
const ROWS = 500;
/** Live fills vs the venue's position: equal within rounding. */
const SAME = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol * Math.abs(b);

type StatusEntry = Extract<LedgerEntry, { kind: "status" }>;
const lastRef = (entries: LedgerEntry[]) =>
  entries.filter((e): e is StatusEntry => e.kind === "status" && typeof e.payload.ref === "string").at(-1)?.payload.ref ?? null;

async function proposalFor(desk: ReconcileDesk, o: Opportunity, entries: LedgerEntry[]): Promise<ProposalRecord | null> {
  const ref = lastRef(entries);
  if (ref) return desk.store.getProposal(ref);
  // ponytail: scans the latest 100 proposals; the approve route places within seconds of the decision.
  return (await desk.store.listProposals({ limit: 100 })).find((p) => p.decidedBy?.includes(placedBy(o.id))) ?? null;
}

/** null when the venue cannot be read this run. Live: the position must still be this proposal's fill (size and entry). */
async function positionOpen(desk: ReconcileDesk, o: Opportunity, ref: string): Promise<boolean | null> {
  if (!desk.broker.live) return (await desk.store.paperPositions()).some((p) => p.proposalId === ref);
  const fill = ((await desk.store.getProposal(ref))?.execution as ExecutionResult | null)?.fills?.[0];
  if (!fill) return false;
  const a = await desk.account();
  if (!a.available) return null;
  return a.positions.some((p) => p.coin.toLowerCase() === o.coin.toLowerCase() && p.side === o.direction && SAME(p.size, fill.size, 1e-6) && SAME(p.entryPx, fill.px, 1e-4));
}

/** One pass. Returns the moves made (for tests and logs). */
export async function reconcileOnce({ store, desk: getDesk, now }: ReconcileDeps, alerted = new Set<string>()): Promise<Array<{ id: string; to: "open" | "failed" | "closed" }>> {
  const desk = getDesk();
  const moved: Array<{ id: string; to: "open" | "failed" | "closed" }> = [];
  const t = now().getTime();
  for (const o of await store.listOpportunities({ statuses: ["approved", "open"], limit: ROWS })) {
    const entries = await store.ledgerFor(o.id);
    if (o.status === "approved") {
      const age = t - Date.parse(o.statusChangedAt);
      if (placing.has(o.id) || age < STUCK_APPROVED_MS) continue;
      const p = await proposalFor(desk, o, entries);
      if (!p && age < PLACEMENT_BOUND_MS) continue;
      if (p?.status === "pending") {
        // Still at the venue (or its record write was lost): a human looks, code does not guess.
        if (age >= PLACEMENT_BOUND_MS && !alerted.has(o.id)) {
          alerted.add(o.id);
          await desk.alert("warn", `Approval stuck: ${o.coin} ${o.direction}`, `Desk proposal ${p.id} is still pending ${Math.round(age / 60_000)} min after the approve of opportunity ${o.id}. Check the venue.`);
        }
        continue;
      }
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
  const alerted = new Set<string>();
  return {
    name: "reconcile",
    intervalSec: 60,
    run: async () => {
      for (const m of await reconcileOnce(deps, alerted)) console.log(deps.now().toISOString(), "[reconcile]", m.id, "→", m.to);
    },
  };
}
