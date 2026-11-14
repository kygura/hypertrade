import type { Side } from "../../shared/intel.js";
import type { LiquidityTier } from "../../shared/platform.js";
import type { RingPoint } from "./features.js";
import { horizonMs, netReturn } from "./outcomes.js";
import { SCORE_VERSION } from "./score.js";
import { evaluateTick, SETUPS, type SetupSchema } from "./setups.js";
import { groupStats } from "./stats.js";
import { dedupeKey, type OutcomeRow } from "./store.js";

// Intraday setup replay (docs/RESEARCH.md § Signals v2, "Intraday replay"). Pure: per-coin streams of ring points in,
// the entries the shipped setup predicate would have made and their graded outcomes out.
//
// What it tests: the setup predicate (setups.ts evaluateTick, the exact path the live scanner tick runs: 24 h ring ->
// computeFeatures -> liquidityTiers -> setupsFor) plus the scanner's dedupe, ready TTL and cooldown. What it does not:
// the score (it orders candidates and picks which get costs, it never gates creation), operator decisions,
// book-based costs (no historical book: slippage 0), and features whose input the stream lacks (null, as the scanner
// treats any unknown feature: it fails every condition). No look-ahead: step t reads points with ts <= t only.

const MIN = 60_000;
/** The scanner's ring span. */
export const RING_MS = 24 * 60 * MIN;

/** A stream input a feature needs beyond mark, funding and 24 h volume. */
export type StreamInput = "oi" | "book" | "liquidations";
/** Features that read an input a stream may not carry (features.ts computeFeatures). */
const FEATURE_INPUTS: Record<string, StreamInput[]> = {
  oiChg1hZ: ["oi"],
  liqPressure: ["liquidations", "oi"],
  spreadBps: ["book"],
  depthUsd: ["book"],
};
const INPUT_TEXT: Record<StreamInput, string> = { oi: "intraday open interest", book: "an order book", liquidations: "tracked liquidation levels" };

/** Feature refs a setup reads: its conditions and its direction. */
export function setupRefs(s: SetupSchema): string[] {
  const refs = s.when.flatMap((c) => ("sameSign" in c ? c.sameSign : [c.f]));
  if (typeof s.direction !== "string") refs.push(s.direction.signOf);
  return [...new Set(refs)];
}

/**
 * Whether a setup can fire at all on a stream missing `missing`: a feature built from a missing input is null on
 * every step, so the setup is not evaluable (reported as such, never as "0 events").
 */
export function evaluability(s: SetupSchema, missing: readonly StreamInput[]): { evaluable: true } | { evaluable: false; reason: string } {
  const lacking = setupRefs(s).flatMap((f) => (FEATURE_INPUTS[f] ?? []).filter((i) => missing.includes(i)).map((i) => ({ f, i })));
  if (!lacking.length) return { evaluable: true };
  const fs = [...new Set(lacking.map((x) => x.f))].join(", ");
  const is = [...new Set(lacking.map((x) => INPUT_TEXT[x.i]))].join(", ");
  return { evaluable: false, reason: `reads ${fs}, which needs ${is}; the stream has none` };
}

export type ReplayEntry = { coin: string; kind: string; direction: Side; ts: number; entryPx: number; tier: LiquidityTier; regime: string; fundingHourly: number | null };

export interface ReplayOpts {
  /** Per coin, ring points ascending by ts. */
  streams: Map<string, RingPoint[]>;
  /** Step times, ascending. A coin is live at a step only when it has a point at exactly that ts. */
  grid: number[];
  /** Other coins' 24 h volume, ranked with the step's volumes for the liquidity tiers (their history is not replayed). */
  tierContext?: Array<{ coin: string; dayNtlVlm: number }>;
  /** PLATFORM_READY_TTL_MIN, ms: a fired idea stays live this long (dedupe), then expires. */
  readyTtlMs: number;
  /** PLATFORM_COOLDOWN_MIN, ms: after expiry the key cannot fire again for this long. */
  cooldownMs: number;
}

/** Index of the first point with ts > t (binary search). */
function upper(pts: RingPoint[], t: number): number {
  let lo = 0;
  let hi = pts.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (pts[m]!.ts <= t) lo = m + 1;
    else hi = m;
  }
  return lo;
}

/**
 * Walks the grid forward and records every idea the scanner would have created. Dedupe, TTL and cooldown as the
 * scanner with every candidate costed and nobody deciding: a fired key is created, goes ready the same tick, stays
 * live (a re-fire only refreshes it) until the first step >= readyTtl after creation, expires there, and is not
 * created again until cooldown has passed since that expiry. Live, a candidate the scanner does not cost (beyond
 * PLATFORM_COST_TOP_N, or no book) stays `new`, never expires and blocks re-fires of its key: the replay does not
 * model that (replay.test.ts shows the divergence).
 */
export function replayEntries(o: ReplayOpts): ReplayEntry[] {
  const r = replayer(o);
  for (const t of o.grid) r.step(t);
  return r.out;
}

/** Hands the event loop back (timers and I/O run) before the next slice of replay work. */
export const yieldToLoop = (): Promise<void> => new Promise((r) => setImmediate(r));
/** Longest a replay computes before it yields to the event loop. */
const REPLAY_SLICE_MS = 20;

/**
 * replayEntries without holding the event loop: grid steps run in slices of at most about `sliceMs` of wall time,
 * `yieldFn` awaited between slices, so requests the same process serves are not blocked for the whole replay. Same
 * entries as replayEntries.
 */
export async function replayEntriesAsync(o: ReplayOpts, yieldFn: () => Promise<void> = yieldToLoop, sliceMs = REPLAY_SLICE_MS, clock: () => number = () => performance.now()): Promise<ReplayEntry[]> {
  const r = replayer(o);
  let since = clock();
  for (const t of o.grid) {
    r.step(t);
    if (clock() - since >= sliceMs) {
      await yieldFn();
      since = clock();
    }
  }
  return r.out;
}

/** The replay's state and one grid step (steps must come in ascending order). */
function replayer(o: ReplayOpts) {
  const out: ReplayEntry[] = [];
  const live = new Map<string, number>(); // key -> ready since
  const ended = new Map<string, number>(); // key -> expired at
  const context = (o.tierContext ?? []).filter((c) => !o.streams.has(c.coin));
  const step = (t: number) => {
    const rings = new Map<string, RingPoint[]>();
    for (const [coin, pts] of o.streams) {
      const hi = upper(pts, t);
      if (!hi || pts[hi - 1]!.ts !== t) continue;
      rings.set(coin, pts.slice(upper(pts, t - RING_MS - 1), hi)); // ts >= t - RING_MS, as the scanner's ring
    }
    if (!rings.size) return;
    const vols = [...[...rings].map(([coin, r]) => ({ coin, dayNtlVlm: r.at(-1)!.dayNtlVlm })), ...context];
    for (const { coin, fv, tier, setups } of evaluateTick({ t, vols, coins: [...rings.keys()], ring: (c) => rings.get(c) ?? [] })) {
      for (const s of setups) {
        const key = dedupeKey({ coin, direction: s.direction, setupKind: s.setupKind });
        if (live.has(key)) continue;
        const e = ended.get(key);
        if (e !== undefined && t - e < o.cooldownMs) continue;
        live.set(key, t);
        const last = rings.get(coin)!.at(-1)!;
        out.push({ coin, kind: s.setupKind, direction: s.direction, ts: t, entryPx: last.mark, tier, regime: String(fv.inputs.regime ?? "unknown"), fundingHourly: Number.isFinite(last.funding) ? last.funding : null });
      }
    }
    for (const [key, since] of live) if (t - since >= o.readyTtlMs) (live.delete(key), ended.set(key, t));
  };
  return { out, step };
}

/** Cost assumptions of a replayed outcome (no historical book). */
const REPLAY_COSTS = { slippageBps: 0 } as const;

/**
 * An entry's outcome at a horizon, as the ledger grades one (outcomes.ts netReturn): exit at the stream's mark at the
 * first point in [ts + horizon, ts + horizon + toleranceMs]; fee each way (feeBps), slippage 0, funding = the hourly
 * rate at entry × horizon hours, signed for the side (the ledger charges the creation funding scaled to the horizon).
 * null when the stream has no point there (past its end, or a gap). The tolerance is for streams off a fixed grid
 * (scan snapshots carry each tick's wall clock, ms-jittered, so no point sits exactly at entry + horizon): the exit is
 * never before the horizon and at most `toleranceMs` after it, which is the only look-ahead past the horizon.
 */
export function gradeEntry(e: ReplayEntry, stream: RingPoint[], horizon: string, feeBps: number, toleranceMs = 0): OutcomeRow | null {
  const at = e.ts + horizonMs(horizon);
  const p = stream[upper(stream, at - 1)]; // the first point with ts >= at
  if (!p || p.ts > at + toleranceMs || !(p.mark > 0)) return null;
  const fundingBps = (e.direction === "long" ? 1 : -1) * (e.fundingHourly ?? 0) * (horizonMs(horizon) / 3_600_000) * 1e4;
  const costs = { feeBps, slippageBps: REPLAY_COSTS.slippageBps, fundingBps };
  const a = { direction: e.direction, entryPx: e.entryPx, horizonPx: p.mark };
  return {
    opportunityId: `${e.coin}|${e.kind}|${e.direction}|${e.ts}`, setupKind: e.kind, regime: e.regime, scoreVersion: SCORE_VERSION,
    liquidityTier: e.tier, horizon, createdAtMs: e.ts,
    grossReturn: netReturn({ ...a, costs: { feeBps: 0, slippageBps: 0, fundingBps: 0 } }), netReturn: netReturn({ ...a, costs }),
    hasCosts: true,
  };
}

export type ReplayRow = {
  kind: string; side: Side; horizon: string; evaluable: boolean; reason?: string;
  /** Ideas created; `n` counts those graded at this horizon (an entry too close to the stream's end is not). */
  entries: number; n: number; clusters: number; meanNet: number | null; ci95: [number, number] | null; hitRate: number | null;
};

const sidesOf = (s: SetupSchema): Side[] => (typeof s.direction === "string" ? [s.direction] : ["long", "short"]);

/**
 * Per setup kind × side × horizon: groupStats over the graded entries, so the numbers mean what the ledger's mean
 * (n per outcome, clusters, mean net over cluster means, t-interval null under 5 clusters, hit rate). A kind × side
 * with no graded entry is n 0 with null numbers; a setup not evaluable on the stream says why.
 */
export function summarise(o: {
  entries: ReplayEntry[];
  streams: Map<string, RingPoint[]>;
  horizons: string[];
  missing: readonly StreamInput[];
  feeBps: number;
  /** gradeEntry's exit tolerance past the horizon; 0 (default) on a fixed grid. */
  toleranceMs?: number;
  schemas?: SetupSchema[];
}): ReplayRow[] {
  const rows: ReplayRow[] = [];
  for (const s of o.schemas ?? SETUPS) {
    const ev = evaluability(s, o.missing);
    for (const side of sidesOf(s)) {
      const es = o.entries.filter((e) => e.kind === s.kind && e.direction === side);
      for (const horizon of o.horizons) {
        const graded = es.flatMap((e) => gradeEntry(e, o.streams.get(e.coin) ?? [], horizon, o.feeBps, o.toleranceMs) ?? []);
        const g = groupStats(graded).find((x) => x.horizon === horizon);
        rows.push({
          kind: s.kind, side, horizon, evaluable: ev.evaluable, ...(!ev.evaluable && { reason: ev.reason }),
          entries: es.length, n: g?.n ?? 0, clusters: g?.clusters ?? 0, meanNet: g?.meanNet ?? null, ci95: g?.ci95 ?? null, hitRate: g?.hitRate ?? null,
        });
      }
    }
  }
  return rows;
}
