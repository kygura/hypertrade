import type { Opportunity } from "../../shared/platform.js";
import { DEFAULT_TAKER_FEE_BPS } from "./costs.js";
import { dueHorizons, horizonMs, netReturn, parseHorizons } from "./outcomes.js";
import type { LoopDef } from "./runtime.js";
import type { PlatformStore } from "./store.js";

// Outcomes loop (SPEC P0.4 outcomes, P0.13): marks every idea to market at each horizon that has
// come due, including rejected and expired ones. Append-only: one `outcome` entry per (idea, horizon).

/** A horizon more overdue than this is skipped: the price now is not the price then (server was down). */
const GRACE_MS = 15 * 60_000;

export interface OutcomesDeps {
  store: PlatformStore;
  /** Live ws mid, null when stale or unknown. */
  mid: (coin: string) => number | null;
  /** Mark from the latest scan: the fallback. */
  scanMark: (coin: string) => number | null;
  horizons?: string[];
  now?: () => number;
}

export function createOutcomesLoop(deps: OutcomesDeps) {
  const { store } = deps;
  const now = deps.now ?? Date.now;
  const horizons = deps.horizons ?? parseHorizons(process.env.PLATFORM_OUTCOME_HORIZONS?.trim() || "1h,4h,24h,72h");
  const maxMs = Math.max(...horizons.map(horizonMs));
  /** Horizons already marked, per opportunity; loaded from the ledger the first time one comes due. */
  const marked = new Map<string, Set<string>>();

  async function tick() {
    const t = now();
    const cutoff = t - maxMs - GRACE_MS;
    // ponytail: scans up to 5000 rows a minute; add a createdAt filter to listOpportunities when the table outgrows it.
    for (const o of await store.listOpportunities({ limit: 5000 })) {
      if (Date.parse(o.createdAt) < cutoff) continue;
      let due = dueHorizons(o.createdAt, horizons, marked.has(o.id) ? [...marked.get(o.id)!] : [], new Date(t));
      if (!due.length) continue;
      if (!marked.has(o.id)) {
        marked.set(o.id, new Set((await store.ledgerFor(o.id)).flatMap((e) => (e.kind === "outcome" ? [e.payload.horizon] : []))));
        due = dueHorizons(o.createdAt, horizons, [...marked.get(o.id)!], new Date(t));
      }
      for (const h of due) {
        if (t - Date.parse(o.createdAt) - horizonMs(h) > GRACE_MS) continue;
        try {
          await mark(o, h);
          marked.get(o.id)!.add(h);
        } catch (err) {
          console.error(`[outcomes] ${o.coin} ${h}:`, err instanceof Error ? err.message : err);
        }
      }
    }
  }

  async function mark(o: Opportunity, horizon: string) {
    const horizonPx = deps.mid(o.coin) ?? deps.scanMark(o.coin);
    // ponytail: entry is the mark at creation. A paper fill price for opened ideas needs the desk fill path (T5); wire it here.
    if (horizonPx == null || o.entryPx == null) throw new Error("no price");
    const c = o.costs ?? { feeBps: DEFAULT_TAKER_FEE_BPS, slippageBps: 0, fundingBps: 0 }; // no book at creation: fee-only
    const a = { direction: o.direction, entryPx: o.entryPx, horizonPx, costs: c };
    await store.appendLedger({
      opportunityId: o.id,
      kind: "outcome",
      payload: { horizon, entryBasis: "mark", entryPx: o.entryPx, horizonPx, grossReturn: netReturn({ ...a, costs: { feeBps: 0, slippageBps: 0, fundingBps: 0 } }), netReturn: netReturn(a) },
    });
  }

  return { tick, def: { name: "outcomes", intervalSec: 60, run: tick } satisfies LoopDef };
}
