import type { LiqLevel } from "../routine/liquidity.js";
import type { Book } from "./costs.js";

// Resting book depth near liquidity levels (docs/SPEC.md § sweep): context for the sweep alert, never a tripwire
// condition. A wall is a snapshot and can be pulled (spoofed) the next second. Pure.

/** HL l2Book returns 20 levels a side; nSigFigs 2–5 aggregates them (null = full precision). */
const BOOK_LEVELS = 20;
const SIG_FIGS = [5, 4, 3, 2] as const;
export const WALL = {
  /** Book half-width the aggregation aims to cover, in ATR. */
  coverAtr: 2,
  /** A level this many times the median level's USD is a wall. */
  multiple: 3,
  /** A wall this close to a liquidity level, in ATR, is flagged. */
  nearAtr: 0.25,
} as const;

/** Aggregation step of nSigFigs `n` at `px`: one unit in the n-th significant figure. */
export const sigStep = (px: number, n: number) => 10 ** (Math.floor(Math.log10(px)) - n + 1);

/** The finest nSigFigs whose 20 levels a side still span coverAtr × ATR; 2 (the coarsest) when none does. */
export function sigFigsFor(px: number, atr: number): (typeof SIG_FIGS)[number] {
  for (const n of SIG_FIGS) if (BOOK_LEVELS * sigStep(px, n) >= WALL.coverAtr * atr) return n;
  return 2;
}

export interface BookWall {
  side: "bid" | "ask";
  px: number;
  usd: number;
  /** usd over the median level's usd (both sides). */
  multiple: number;
  level: Pick<LiqLevel, "key" | "px">;
  /** |px − level| in ATR. */
  distAtr: number;
}

const r2 = (x: number) => Math.round(x * 100) / 100;

/** Book levels of at least WALL.multiple × the median level (USD, both sides) within WALL.nearAtr × ATR of a level. Largest first. */
export function bookWalls(book: Book, levels: Array<Pick<LiqLevel, "key" | "px">>, atr: number): BookWall[] {
  if (!(atr > 0)) return [];
  const rows = [...book.bids.map((l) => ({ side: "bid" as const, px: l.px, usd: l.px * l.sz })), ...book.asks.map((l) => ({ side: "ask" as const, px: l.px, usd: l.px * l.sz }))];
  if (rows.length < 5) return [];
  const sorted = rows.map((r) => r.usd).sort((a, b) => a - b);
  const median = sorted.length % 2 ? sorted[(sorted.length - 1) / 2]! : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2;
  if (!(median > 0)) return [];
  const out: BookWall[] = [];
  for (const r of rows) {
    if (r.usd < WALL.multiple * median) continue;
    const near = levels.map((l) => ({ l, d: Math.abs(r.px - l.px) / atr })).filter((x) => x.d <= WALL.nearAtr).sort((a, b) => a.d - b.d)[0];
    if (near) out.push({ ...r, usd: Math.round(r.usd), multiple: r2(r.usd / median), level: { key: near.l.key, px: near.l.px }, distAtr: r2(near.d) });
  }
  return out.sort((a, b) => b.usd - a.usd);
}
