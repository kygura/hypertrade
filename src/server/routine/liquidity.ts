import { bucketBounds, type LiqMapSnapshot } from "../../shared/platform.js";
import type { Candle } from "../../shared/types.js";
import type { LevelKey } from "./board.js";

// Liquidity levels and sweeps (docs/fallback-routine.md § Tripwires, liquidity_sweep). Pure. Stops and liquidations
// cluster at the levels everyone can see: the prior range, the previous day and week, equal highs/lows, round
// numbers. A sweep is a bar that trades through such a level and closes back inside it; the cleared notional is what
// the liquidation map held between the level and the wick before the bar. Facts for the board, the tripwire, the
// live alert (platform/sweepLoop.ts) and the Lab metric (ht:sweep); no verdict.

export type LiqLevelSource = "range20" | "pdh" | "pdl" | "pwh" | "pwl" | "range12w" | "equal" | "round";
export interface LiqLevel {
  px: number;
  side: "high" | "low";
  source: LiqLevelSource;
  /** Swing points at an equal high/low; 1 for every other level; summed when levels merge. */
  touches: number;
  /** Menu key ("1d.pdl"), `eq:<side>:<px>` or `round:<px>`: stable for one level across runs (alert dedupe). */
  key: string;
}

export interface SweepRead {
  level: LiqLevel;
  tf: "4h" | "1d";
  side: "high" | "low";
  /** The swept bar's open time. */
  t: number;
  /** The wick's extreme beyond the level (bar high for a high sweep, bar low for a low sweep). */
  wick: number;
  /** Wick beyond the level, in that timeframe's ATR. */
  depthAtr: number;
  /** Closed back inside the level. A bar that traded through and closed beyond is a breakout: reclaimed false. */
  reclaimed: boolean;
  /** Beyond-level wick over the bar's range. */
  wickShare: number;
}

export interface ClearedLiquidity {
  /** Tracked liquidation notional between the level and the wick, read from the snapshot before the bar. */
  clearedUsd: number;
  /** clearedUsd over that side's tracked notional within ±20% of the snapshot's mark. */
  shareOfSide: number;
  /** Tracked over OI (liqmap coverage); null = unknown. clearedUsd is a lower bound by this ratio. */
  coverageRatio: number | null;
}

export const LIQUIDITY = {
  /** Equal highs/lows: swing points within the last this-many days. */
  equalDays: 30,
  /** Equal tolerance: max(this × ATR(1d), equalMinBps of price). */
  equalAtr: 0.1,
  equalMinBps: 15,
  /** Levels closer than this × ATR(1d) merge into the higher-priority one. */
  dedupeAtr: 0.1,
  /** Round numbers further than this × ATR(1d) from the mark are not levels. */
  roundAtr: 1,
  /** clearedLiquidity's share-of-side window around the snapshot mark. */
  shareRange: 0.2,
} as const;

const DAY = 86_400_000;
const PRIORITY: Record<LiqLevelSource, number> = { equal: 5, pwh: 4, pwl: 4, pdh: 3, pdl: 3, range20: 2, range12w: 2, round: 1 };

/** The level menu's highs and lows (no SMAs, no mark): key, source, side. */
const MENU: ReadonlyArray<[LevelKey, LiqLevelSource, LiqLevel["side"]]> = [
  ["4h.high20", "range20", "high"],
  ["4h.low20", "range20", "low"],
  ["1d.pdh", "pdh", "high"],
  ["1d.pdl", "pdl", "low"],
  ["1d.high20", "range20", "high"],
  ["1d.low20", "range20", "low"],
  ["1w.pwh", "pwh", "high"],
  ["1w.pwl", "pwl", "low"],
  ["1w.high12", "range12w", "high"],
  ["1w.low12", "range12w", "low"],
];

const sig = (x: number) => Number(x.toPrecision(10));

/**
 * Equal highs (or lows): two or more 3-bar fractal swing points on completed 4h bars of the last 30 days within
 * `tol` of each other, with no close beyond the group's extreme since its first swing. The level is that extreme.
 */
export function equalLevels(c4h: Candle[], side: LiqLevel["side"], tol: number, now: number): LiqLevel[] {
  const done = c4h.filter((c) => c.T < now && c.t >= now - LIQUIDITY.equalDays * DAY).sort((a, b) => a.t - b.t);
  const hi = side === "high";
  const swings: Candle[] = [];
  for (let i = 1; i + 1 < done.length; i++) {
    const [a, b, c] = [done[i - 1]!, done[i]!, done[i + 1]!];
    if (hi ? b.h > a.h && b.h > c.h : b.l < a.l && b.l < c.l) swings.push(b);
  }
  const groups: Candle[][] = [];
  for (const s of swings) {
    const px = hi ? s.h : s.l;
    const g = groups.find((x) => Math.abs((hi ? x[0]!.h : x[0]!.l) - px) <= tol);
    if (g) g.push(s);
    else groups.push([s]);
  }
  const out: LiqLevel[] = [];
  for (const g of groups) {
    if (g.length < 2) continue;
    const px = hi ? Math.max(...g.map((c) => c.h)) : Math.min(...g.map((c) => c.l));
    const first = g[0]!.t;
    if (done.some((c) => c.t > first && (hi ? c.c > px : c.c < px))) continue;
    out.push({ px, side, source: "equal", touches: g.length, key: `eq:${side}:${sig(px)}` });
  }
  return out;
}

/**
 * Nearest round number above and below the mark: step = 10^(floor(log10(mark)) − 1) × {5, 2.5, 1}, the roundest
 * step whose level lies within roundAtr × ATR(1d). At most one per side; none without an ATR.
 */
export function roundLevels(mark: number, atr1d: number | null): LiqLevel[] {
  if (!(mark > 0) || !(atr1d && atr1d > 0)) return [];
  const base = 10 ** (Math.floor(Math.log10(mark)) - 1);
  const out: LiqLevel[] = [];
  for (const side of ["high", "low"] as const) {
    for (const m of [5, 2.5, 1]) {
      const step = base * m;
      const k = side === "high" ? Math.floor(mark / step) + 1 : Math.ceil(mark / step) - 1;
      const px = sig(k * step);
      if (px > 0 && Math.abs(px - mark) <= LIQUIDITY.roundAtr * atr1d) {
        out.push({ px, side, source: "round", touches: 1, key: `round:${px}` });
        break;
      }
    }
  }
  return out;
}

/**
 * The liquidity levels in force at `now`: the menu's highs and lows (`levels`, built from bars closed before `now`),
 * equal highs/lows and round numbers. Highs at or above the mark, lows at or below it. Levels within dedupeAtr ×
 * ATR(1d) of each other on one side merge into the highest-priority one (equal > pwh/pwl > pdh/pdl > range > round),
 * summing touches. Sorted by price.
 */
export function liquidityLevels(i: { mark: number; c4h: Candle[]; c1d: Candle[]; levels: Partial<Record<LevelKey, number>>; atr1d: number | null; now: number }): LiqLevel[] {
  const { mark, atr1d } = i;
  const raw: LiqLevel[] = [];
  for (const [key, source, side] of MENU) {
    const px = i.levels[key];
    if (px !== undefined && px > 0) raw.push({ px, side, source, touches: 1, key });
  }
  const tol = Math.max(LIQUIDITY.equalAtr * (atr1d ?? 0), (LIQUIDITY.equalMinBps / 1e4) * mark);
  raw.push(...equalLevels(i.c4h, "high", tol, i.now), ...equalLevels(i.c4h, "low", tol, i.now), ...roundLevels(mark, atr1d));
  const merge = atr1d && atr1d > 0 ? LIQUIDITY.dedupeAtr * atr1d : (LIQUIDITY.equalMinBps / 1e4) * mark;
  const kept: LiqLevel[] = [];
  for (const l of raw.filter((x) => (x.side === "high" ? x.px >= mark : x.px <= mark)).sort((a, b) => PRIORITY[b.source] - PRIORITY[a.source])) {
    const near = kept.find((k) => k.side === l.side && Math.abs(k.px - l.px) <= merge);
    if (near) near.touches += l.touches;
    else kept.push({ ...l });
  }
  return kept.sort((a, b) => a.px - b.px);
}

const r2 = (x: number) => Math.round(x * 100) / 100;

/**
 * The bar's sweep of a level: the wick traded beyond it. A sweep that closed back inside (reclaimed) wins over one
 * that closed beyond; among those, the farthest level the wick reached. When both sides were swept, the larger
 * beyond-level wick share. Null when no level was traded through or there is no ATR.
 */
export function sweepOf(bar: Candle, levels: LiqLevel[], atr: number | null, tf: SweepRead["tf"] = "4h"): SweepRead | null {
  if (!(atr && atr > 0)) return null;
  const range = bar.h - bar.l;
  const reads: SweepRead[] = [];
  for (const side of ["high", "low"] as const) {
    const hi = side === "high";
    const wick = hi ? bar.h : bar.l;
    const hit = levels.filter((l) => l.side === side && (hi ? bar.h > l.px : bar.l < l.px));
    if (!hit.length) continue;
    const inside = (l: LiqLevel) => (hi ? bar.c <= l.px : bar.c >= l.px);
    const pool = hit.some(inside) ? hit.filter(inside) : hit;
    const level = pool.reduce((a, b) => (hi ? (b.px > a.px ? b : a) : b.px < a.px ? b : a));
    const beyond = Math.abs(wick - level.px);
    reads.push({ level, tf, side, t: bar.t, wick, depthAtr: r2(beyond / atr), reclaimed: inside(level), wickShare: range > 0 ? r2(beyond / range) : 0 });
  }
  if (!reads.length) return null;
  return reads.sort((a, b) => Number(b.reclaimed) - Number(a.reclaimed) || b.wickShare - a.wickShare)[0]!;
}

/** The latest snapshot taken at or before `t` (the liquidity in place before a bar that opens at `t`). */
export function snapshotBefore(snaps: LiqMapSnapshot[], t: number): LiqMapSnapshot | null {
  let best: LiqMapSnapshot | null = null;
  for (const s of snaps) {
    const at = Date.parse(s.ts);
    if (at <= t && (!best || at > Date.parse(best.ts))) best = s;
  }
  return best;
}

/**
 * Liquidation notional the sweep cleared: longs between the wick low and the level for a low sweep, shorts between
 * the level and the wick high for a high sweep, read from `pre` (the snapshot before the bar: after it those
 * positions are gone). A cell partly inside the zone counts in proportion. Null without a snapshot: unknown, not 0.
 */
export function clearedLiquidity(i: { pre: LiqMapSnapshot | null; sweep: Pick<SweepRead, "side" | "level">; wickExtreme: number; coverageRatio: number | null }): ClearedLiquidity | null {
  const { pre, sweep } = i;
  if (!pre) return null;
  const low = sweep.side === "low";
  const [lo, hi] = low ? [i.wickExtreme, sweep.level.px] : [sweep.level.px, i.wickExtreme];
  const key = low ? "longUsd" : "shortUsd";
  let cleared = 0;
  let total = 0;
  for (const cell of pre.buckets) {
    const b = bucketBounds(cell.idx, pre.bucketBps);
    const overlap = Math.min(hi, b.priceHi) - Math.max(lo, b.priceLo);
    if (overlap > 0) cleared += (cell[key] * overlap) / (b.priceHi - b.priceLo);
    const mid = (b.priceLo + b.priceHi) / 2;
    if (Math.abs(mid / pre.mark - 1) <= LIQUIDITY.shareRange) total += cell[key];
  }
  return { clearedUsd: Math.round(cleared), shareOfSide: total > 0 ? r2(cleared / total) : 0, coverageRatio: i.coverageRatio };
}
