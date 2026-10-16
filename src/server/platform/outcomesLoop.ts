import { fetchCandles, HL_MAX_CANDLES } from "../../shared/hl-client.js";
import type { Candle } from "../../shared/types.js";
import type { Opportunity } from "../../shared/platform.js";
import { DEFAULT_TAKER_FEE_BPS } from "./costs.js";
import { dueHorizons, horizonMs, netReturn, parseHorizons } from "./outcomes.js";
import type { LoopDef } from "./runtime.js";
import { HOLD_HOURS } from "./scanner.js";
import type { PlatformStore } from "./store.js";

// Outcomes loop (SPEC P0.4 outcomes, P0.13): marks every idea to market at each horizon that has
// come due, including rejected and expired ones. Append-only: one `outcome` entry per (idea, horizon).

/** A horizon more overdue than this is priced from the 1-min candle at its timestamp: the price now is not the price then (server was down). */
const GRACE_MS = 15 * 60_000;
/** HL keeps the latest 5000 1-min candles; a horizon older than that cannot be priced (margin: the page edge moves). */
const CANDLE_RANGE_MS = (HL_MAX_CANDLES - 5) * 60_000;

let skippedN = 0;
/** Horizons too old for HL's candle history, never marked. Counted once per process; health shows it as outcomesSkipped. */
export const skipped = () => skippedN;

export interface OutcomesDeps {
  store: PlatformStore;
  /** Live ws mid, null when stale or unknown. */
  mid: (coin: string) => number | null;
  /** Mark from the latest scan: the fallback. */
  scanMark: (coin: string) => number | null;
  /** Paper fill price of a desk proposal, null when unknown. */
  fillPx?: (proposalId: string) => Promise<number | null>;
  /** 1-min candles in [start, end] for the late-horizon price; default is HL candleSnapshot (under the weight guard). */
  candles?: (coin: string, startMs: number, endMs: number) => Promise<Candle[]>;
  horizons?: string[];
  now?: () => number;
}

export function createOutcomesLoop(deps: OutcomesDeps) {
  const { store } = deps;
  const now = deps.now ?? Date.now;
  const horizons = deps.horizons ?? parseHorizons(process.env.PLATFORM_OUTCOME_HORIZONS?.trim() || "1h,4h,24h,72h");
  const maxMs = Math.max(...horizons.map(horizonMs));
  const candles = deps.candles ?? ((coin: string, s: number, e: number) => fetchCandles(coin, "1m", s, e));
  /** Horizons already marked, per opportunity; loaded from the ledger the first time one comes due. */
  const marked = new Map<string, Set<string>>();

  async function tick() {
    const t = now();
    const cutoff = t - maxMs - CANDLE_RANGE_MS;
    // ponytail: scans up to 5000 rows a minute; add a createdAt filter to listOpportunities when the table outgrows it.
    for (const o of await store.listOpportunities({ limit: 5000 })) {
      if (Date.parse(o.createdAt) < cutoff) {
        marked.delete(o.id); // every horizon is past the candle range: nothing left to mark, so drop the cache entry
        continue;
      }
      let due = dueHorizons(o.createdAt, horizons, marked.has(o.id) ? [...marked.get(o.id)!] : [], new Date(t));
      if (!due.length) continue;
      if (!marked.has(o.id)) {
        marked.set(o.id, new Set((await store.ledgerFor(o.id)).flatMap((e) => (e.kind === "outcome" ? [e.payload.horizon] : []))));
        due = dueHorizons(o.createdAt, horizons, [...marked.get(o.id)!], new Date(t));
      }
      for (const h of due) {
        try {
          const dueAt = Date.parse(o.createdAt) + horizonMs(h);
          if (t - dueAt > CANDLE_RANGE_MS) skippedN++;
          else await mark(o, h, dueAt, t - dueAt > GRACE_MS);
          marked.get(o.id)!.add(h);
        } catch (err) {
          console.error(`[outcomes] ${o.coin} ${h}:`, err instanceof Error ? err.message : err);
        }
      }
    }
  }

  /** Close of the 1-min candle containing the horizon time (up to one minute after it). */
  async function candlePx(coin: string, at: number): Promise<number | null> {
    const cs = await candles(coin, at - 60_000, at + 60_000);
    const c = cs.filter((x) => x.t <= at && Number.isFinite(x.c) && x.c > 0).at(-1);
    return c ? c.c : null;
  }

  async function mark(o: Opportunity, horizon: string, dueAt: number, late: boolean) {
    const horizonPx = late ? await candlePx(o.coin, dueAt) : (deps.mid(o.coin) ?? deps.scanMark(o.coin));
    if (horizonPx == null || o.entryPx == null) throw new Error("no price");
    const base = o.costs ?? { feeBps: DEFAULT_TAKER_FEE_BPS, slippageBps: 0, fundingBps: 0 }; // no book at creation: fee-only
    // Creation costs charge funding over HOLD_HOURS; an outcome holds for the horizon.
    let c = { ...base, fundingBps: (base.fundingBps * horizonMs(horizon)) / (HOLD_HOURS * 3_600_000) };
    let entryPx = o.entryPx;
    let entryBasis: "mark" | "fill" = "mark";
    // An opened idea enters at its paper fill (the ref on its approved -> open entry); the fill already carries slippage.
    if (deps.fillPx && (o.status === "open" || o.status === "closed")) {
      const ref = (await store.ledgerFor(o.id)).flatMap((e) => (e.kind === "status" && e.payload.to === "open" && e.payload.ref ? [e.payload.ref] : []))[0];
      const fill = ref ? await deps.fillPx(ref).catch(() => null) : null;
      if (fill != null && fill > 0 && Number.isFinite(fill)) (entryPx = fill, entryBasis = "fill", c = { ...c, slippageBps: 0 });
    }
    const a = { direction: o.direction, entryPx, horizonPx, costs: c };
    await store.appendLedger({
      opportunityId: o.id,
      kind: "outcome",
      payload: { horizon, entryBasis, entryPx, horizonPx, grossReturn: netReturn({ ...a, costs: { feeBps: 0, slippageBps: 0, fundingBps: 0 } }), netReturn: netReturn(a) },
    });
  }

  return { tick, def: { name: "outcomes", intervalSec: 60, run: tick } satisfies LoopDef };
}
