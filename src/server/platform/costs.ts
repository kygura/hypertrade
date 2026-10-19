import type { Costs } from "../../shared/platform.js";
import type { Side } from "../../shared/intel.js";

// Directional cost model (docs/SPEC.md § Platform P0.10). Pure.
//   slippageBps  walk the live book at the planned size; avg fill vs mid
//   feeBps       taker fee, paid on entry and again on exit (netEdge charges 2x)
//   fundingBps   hourly funding x holding hours; positive means the trade pays
//                (longs pay positive funding, shorts receive it)
//   absorbableUsd 10% of the USD depth on the consumed side within 0.5% of mid (shown, not enforced: R6)
// A book too thin to fill the size gives null: no cost is better than an understated one.

export type Level = { px: number; sz: number };
/** bids best (highest) first, asks best (lowest) first, as HL returns them. */
export type Book = { bids: Level[]; asks: Level[] };

/**
 * Hyperliquid tier-0 perp taker fee, 0.045%. A default, not a hard truth: the account's
 * real tier (volume, staking, referral) changes it, so callers pass their own `takerFeeBps`.
 */
export const DEFAULT_TAKER_FEE_BPS = 4.5;
/** Depth band for absorbableUsd and the depthUsd feature. */
export const DEPTH_BAND_BPS = 50;
export const ABSORB_SHARE = 0.1;

const clean = (rows: Level[]) => rows.filter((l) => Number.isFinite(l.px) && Number.isFinite(l.sz) && l.px > 0 && l.sz > 0);

/** Parses a raw l2Book payload ({levels: [bids, asks]} of {px, sz} strings). Null when a side is empty or the book is crossed. */
export function bookFromL2(raw: unknown): Book | null {
  const lv = (raw as { levels?: unknown } | null)?.levels;
  if (!Array.isArray(lv) || lv.length < 2 || !Array.isArray(lv[0]) || !Array.isArray(lv[1])) return null;
  const side = (rows: Array<{ px?: unknown; sz?: unknown }>) => clean(rows.map((r) => ({ px: Number(r?.px), sz: Number(r?.sz) })));
  const book = { bids: side(lv[0]), asks: side(lv[1]) };
  return midOf(book) == null ? null : book;
}

/** Mid of the best bid and ask; null for an empty or crossed book. */
export function midOf(b: Book): number | null {
  const bid = Math.max(...clean(b.bids).map((l) => l.px));
  const ask = Math.min(...clean(b.asks).map((l) => l.px));
  return Number.isFinite(bid) && Number.isFinite(ask) && ask > bid ? (bid + ask) / 2 : null;
}

/** USD on one side within `bps` of mid. */
export function depthWithin(levels: Level[], mid: number, bps = DEPTH_BAND_BPS): number {
  const lim = mid * (bps / 1e4);
  return clean(levels).reduce((s, l) => (Math.abs(l.px - mid) <= lim ? s + l.px * l.sz : s), 0);
}

/**
 * Fills `sizeUsd` against `levels` (best first; asks for a buy, bids for a sell).
 * avgPx is notional-weighted; slippageBps is the adverse move of avgPx from `refPx` (default: the best level).
 * Null when the size is not positive or the book cannot fill it.
 */
export function walkBook(levels: Level[], side: "buy" | "sell", sizeUsd: number, refPx?: number): { avgPx: number; slippageBps: number } | null {
  const rows = clean(levels);
  if (!(sizeUsd > 0) || !Number.isFinite(sizeUsd) || !rows.length) return null;
  let left = sizeUsd;
  let coins = 0;
  for (const l of rows) {
    const take = Math.min(left, l.px * l.sz);
    coins += take / l.px;
    left -= take;
    if (left <= 1e-9) break;
  }
  if (left > 1e-9) return null;
  const avgPx = sizeUsd / coins;
  const ref = refPx ?? rows[0]!.px;
  const adverse = side === "buy" ? avgPx / ref - 1 : 1 - avgPx / ref;
  return { avgPx, slippageBps: Math.max(0, adverse * 1e4) };
}

export function costs(o: {
  book: Book;
  sizeUsd: number;
  takerFeeBps?: number;
  /** Hourly funding rate (HL's `funding`), signed. */
  fundingHourly: number;
  holdingHours: number;
  direction: Side;
}): Costs | null {
  const mid = midOf(o.book);
  if (mid == null || !Number.isFinite(o.fundingHourly) || !(o.holdingHours >= 0)) return null;
  const buy = o.direction === "long";
  const side = buy ? o.book.asks : o.book.bids;
  const fill = walkBook(side, buy ? "buy" : "sell", o.sizeUsd, mid);
  if (!fill) return null;
  return {
    feeBps: Math.max(0, o.takerFeeBps ?? DEFAULT_TAKER_FEE_BPS),
    slippageBps: fill.slippageBps,
    fundingBps: (buy ? 1 : -1) * o.fundingHourly * o.holdingHours * 1e4,
    absorbableUsd: ABSORB_SHARE * depthWithin(side, mid),
  };
}

/** gross − 2 x fee (in and out) − slippage − funding. */
export const netEdge = (o: { grossEdgeBps: number; costs: Costs }): number => o.grossEdgeBps - 2 * o.costs.feeBps - o.costs.slippageBps - o.costs.fundingBps;
