import { fetchCandles, HL_MAX_CANDLES } from "../../shared/hl-client.js";
import type { Candle } from "../../shared/types.js";
import type { Opportunity, TradeOutcome, UngradedReason } from "../../shared/platform.js";
import { DEFAULT_TAKER_FEE_BPS } from "./costs.js";
import { dueHorizons, horizonMs, netReturn, parseHorizons, tradeExit } from "./outcomes.js";
import type { LoopDef } from "./runtime.js";
import { HOLD_HOURS } from "./scanner.js";
import type { PlatformStore } from "./store.js";

// Outcomes loop (SPEC P0.4 outcomes, P0.13): marks every idea to market at each horizon that has
// come due, including rejected and expired ones. Append-only: one `outcome` entry per (idea, horizon).
// A horizon that can never be priced (past HL's 1-min candle range, three empty candle answers, no entry price) is
// written as an `ungraded` outcome with its reason, so the stats show how many ideas their numbers do not cover.
// The fixed-horizon return is hold-to-horizon, whatever the stop and target. The longest horizon's entry also carries
// `trade`: the trade as ticketed (stop, target), resolved on the 1-min candles from the entry to that horizon
// (outcomes.ts tradeExit). No trade when the idea has no stop or target, the levels do not bracket the entry, or the
// candles do not cover the path (PATH_EDGE_MS at both ends): a touch hidden in missing candles must not read as a hold.

/** A horizon more overdue than this is priced from the 1-min candle at its timestamp: the price now is not the price then (server was down). */
const GRACE_MS = 15 * 60_000;
/** HL keeps the latest 5000 1-min candles; a horizon older than that cannot be priced (margin: the page edge moves). */
const CANDLE_RANGE_MS = (HL_MAX_CANDLES - 5) * 60_000;

/** The path candles must start and end within this of the entry and the horizon to grade the stop/target trade. */
const PATH_EDGE_MS = 15 * 60_000;

/** Candle fetches per tick (late horizons and trade paths): a long outage must not burst a backlog through the weight guard. */
const MAX_LATE_PER_TICK = 10;
/** Empty candle answers for one horizon before it is given up on (an `ungraded` entry, counted in skipped()). */
const MAX_EMPTY = 3;
class NoCandles extends Error {}

/** PLATFORM_OUTCOME_HORIZONS default. */
export const DEFAULT_OUTCOME_HORIZONS = "1h,4h,24h,72h";

/** Ideas past every horizon's candle range that get their missing horizons written as ungraded per tick (the first tick after a long outage). */
const MAX_SETTLE_PER_TICK = 200;

let skippedN = 0;
/**
 * Horizons given up on by this process: each is written to the ledger as an `ungraded` outcome (the reason in its
 * payload), so the ledger stats count it. Health shows this counter as outcomesSkipped.
 */
export const skipped = () => skippedN;

export interface OutcomesDeps {
  store: PlatformStore;
  /** Live ws mid, null when stale or unknown. */
  mid: (coin: string) => number | null;
  /** Mark from the latest scan: the fallback. */
  scanMark: (coin: string) => number | null;
  /** Paper fill price of a desk proposal, null when unknown. */
  fillPx?: (proposalId: string) => Promise<number | null>;
  /** 1-min candles in [start, end] for the late-horizon price and the trade path; default is HL candleSnapshot (under the weight guard). */
  candles?: (coin: string, startMs: number, endMs: number) => Promise<Candle[]>;
  horizons?: string[];
  now?: () => number;
}

export function createOutcomesLoop(deps: OutcomesDeps) {
  const { store } = deps;
  const now = deps.now ?? Date.now;
  const horizons = deps.horizons ?? parseHorizons(process.env.PLATFORM_OUTCOME_HORIZONS?.trim() || DEFAULT_OUTCOME_HORIZONS);
  const maxMs = Math.max(...horizons.map(horizonMs));
  const candles = deps.candles ?? ((coin: string, s: number, e: number) => fetchCandles(coin, "1m", s, e));
  /** Horizons already marked, per opportunity; loaded from the ledger the first time one comes due. */
  const marked = new Map<string, Set<string>>();
  const empties = new Map<string, number>();
  /** Ideas past the candle range whose horizons are all in the ledger (priced or ungraded): nothing left to do. */
  const settled = new Set<string>();
  /** Horizons in the ledger per idea, read once (one outcomeRows read) the first time an unsettled old idea is seen. */
  let ledgerMarks: Map<string, Set<string>> | null = null;

  /** Gives a horizon up for good: an explicit ledger entry, never a silent drop. */
  async function ungraded(o: Opportunity, horizon: string, reason: UngradedReason) {
    if (await store.appendLedger({ opportunityId: o.id, kind: "outcome", payload: { horizon, ungraded: reason } })) skippedN++;
  }

  async function tick() {
    const t = now();
    const cutoff = t - maxMs - CANDLE_RANGE_MS;
    let lateFetches = 0;
    let settles = 0;
    // ponytail: scans up to 5000 rows a minute; add a createdAt filter to listOpportunities when the table outgrows it.
    for (const o of await store.listOpportunities({ limit: 5000 })) {
      if (Date.parse(o.createdAt) < cutoff) {
        // Every horizon is past the candle range. Whatever was never marked (the process was down) becomes ungraded, once.
        if (settled.has(o.id) || settles++ >= MAX_SETTLE_PER_TICK) continue;
        if (!ledgerMarks) {
          ledgerMarks = new Map();
          for (const r of await store.outcomeRows({})) ledgerMarks.set(r.opportunityId, (ledgerMarks.get(r.opportunityId) ?? new Set()).add(r.horizon));
        }
        const have = marked.get(o.id) ?? ledgerMarks.get(o.id);
        for (const h of horizons) if (!have?.has(h)) await ungraded(o, h, o.entryPx == null ? "no_entry_price" : "past_candle_range");
        settled.add(o.id);
        marked.delete(o.id);
        ledgerMarks.delete(o.id);
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
          const late = t - dueAt > GRACE_MS;
          // The trade path is read once, with the longest horizon, while HL still has the candle at the entry.
          const path = horizonMs(h) === maxMs && o.entryPx != null && o.stopPx != null && o.targetPx != null && t - Date.parse(o.createdAt) <= CANDLE_RANGE_MS;
          const fetches = (late ? 1 : 0) + (path ? 1 : 0);
          if (t - dueAt > CANDLE_RANGE_MS) await ungraded(o, h, o.entryPx == null ? "no_entry_price" : "past_candle_range");
          else if (late && o.entryPx == null) continue; // nothing to price against: don't burn a fetch slot
          else if (fetches && lateFetches + fetches > MAX_LATE_PER_TICK) continue; // next tick
          else (lateFetches += fetches), await mark(o, h, dueAt, late, path);
          marked.get(o.id)!.add(h);
        } catch (err) {
          if (err instanceof NoCandles) {
            const key = `${o.id}|${h}`;
            const n = (empties.get(key) ?? 0) + 1;
            if (n >= MAX_EMPTY) {
              empties.delete(key);
              await ungraded(o, h, "no_candles").catch((e) => console.error(`[outcomes] ${o.coin} ${h}:`, e instanceof Error ? e.message : e));
              marked.get(o.id)!.add(h);
            } else empties.set(key, n);
          }
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

  /** The stop/target trade from `fromMs` to the horizon, net of costs with funding over the time held; undefined when it cannot be graded. */
  async function trade(o: Opportunity, a: { entryPx: number; horizonPx: number; fromMs: number; dueAt: number; costs: { feeBps: number; slippageBps: number; fundingBps: number } }): Promise<TradeOutcome | undefined> {
    const cs = (await candles(o.coin, a.fromMs, a.dueAt)).filter((c) => c.t >= a.fromMs && c.t < a.dueAt).sort((x, y) => x.t - y.t);
    if (!cs.length || cs[0]!.t - a.fromMs > PATH_EDGE_MS || a.dueAt - cs.at(-1)!.T > PATH_EDGE_MS) return undefined;
    const x = tradeExit({ direction: o.direction, entryPx: a.entryPx, stopPx: o.stopPx!, targetPx: o.targetPx!, candles: cs, fromMs: a.fromMs, toMs: a.dueAt, horizonPx: a.horizonPx });
    if (!x) return undefined;
    const held = { direction: o.direction, entryPx: a.entryPx, horizonPx: x.exitPx };
    const net = netReturn({ ...held, costs: { ...a.costs, fundingBps: (a.costs.fundingBps * (x.exitAtMs - a.fromMs)) / (HOLD_HOURS * 3_600_000) } });
    return {
      exit: x.exit, exitPx: x.exitPx, exitAt: new Date(x.exitAtMs).toISOString(), stopPx: o.stopPx!, targetPx: o.targetPx!, ambiguous: x.ambiguous,
      grossReturn: netReturn({ ...held, costs: { feeBps: 0, slippageBps: 0, fundingBps: 0 } }), netReturn: net, r: net / (Math.abs(a.entryPx - o.stopPx!) / a.entryPx),
    };
  }

  async function mark(o: Opportunity, horizon: string, dueAt: number, late: boolean, path: boolean) {
    const horizonPx = late ? await candlePx(o.coin, dueAt) : (deps.mid(o.coin) ?? deps.scanMark(o.coin));
    if (horizonPx == null && late) throw new NoCandles("no candle at the horizon");
    if (horizonPx == null || o.entryPx == null) throw new Error("no price");
    const base = o.costs ?? { feeBps: DEFAULT_TAKER_FEE_BPS, slippageBps: 0, fundingBps: 0 }; // no book at creation: fee-only
    // Creation costs charge funding over HOLD_HOURS; an outcome holds for the horizon.
    let c = { ...base, fundingBps: (base.fundingBps * horizonMs(horizon)) / (HOLD_HOURS * 3_600_000) };
    let entryPx = o.entryPx;
    let entryBasis: "mark" | "fill" = "mark";
    let enteredAt = Date.parse(o.createdAt);
    let slippageBps = base.slippageBps;
    // An opened idea enters at its paper fill (the ref on its approved -> open entry); the fill already carries slippage.
    if (deps.fillPx && (o.status === "open" || o.status === "closed")) {
      const opened = (await store.ledgerFor(o.id)).find((e) => e.kind === "status" && e.payload.to === "open" && e.payload.ref);
      const fill = opened?.kind === "status" ? await deps.fillPx(opened.payload.ref!).catch(() => null) : null;
      if (fill != null && fill > 0 && Number.isFinite(fill)) (entryPx = fill, entryBasis = "fill", enteredAt = Date.parse(opened!.createdAt), slippageBps = 0, c = { ...c, slippageBps: 0 });
    }
    const a = { direction: o.direction, entryPx, horizonPx, costs: c };
    // The trade starts where the entry is: the creation mark, or the fill (levels touched before the fill are not its trade).
    const tr = path && enteredAt < dueAt ? await trade(o, { entryPx, horizonPx, fromMs: enteredAt, dueAt, costs: { ...base, slippageBps } }) : undefined;
    await store.appendLedger({
      opportunityId: o.id,
      kind: "outcome",
      payload: { horizon, entryBasis, entryPx, horizonPx, grossReturn: netReturn({ ...a, costs: { feeBps: 0, slippageBps: 0, fundingBps: 0 } }), netReturn: netReturn(a), ...(tr && { trade: tr }) },
    });
  }

  return { tick, def: { name: "outcomes", intervalSec: 60, run: tick } satisfies LoopDef };
}
