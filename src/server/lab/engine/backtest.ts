import type { Objective, PerfStats } from "../types.js";
import { isoDate } from "./util.js";

// Strategy scoring (LAB.md §6). Day indices: pos[i] is the position decided
// at the close of day i and held over day i+1, so the return of day i is
//   r[i] = pos[i−1] · pr[i] − cost · |pos[i−1] − pos[i−2]|,
// with pr[i] = price[i]/price[i−1] − 1 and cost = slippageBps / 1e4. A
// window starts flat: entering on its first day pays slippage, and a position
// still open at its end is marked to market without an exit charge.

/** pr[i] = price[i]/price[i−1] − 1; 0 when either price is missing or non-positive. */
export function priceReturns(price: ArrayLike<number>): Float64Array {
  const n = price.length;
  const pr = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    const a = price[i - 1]!;
    const b = price[i]!;
    pr[i] = a > 0 && b > 0 && Number.isFinite(a) && Number.isFinite(b) ? b / a - 1 : 0;
  }
  return pr;
}

/** Net returns of return days [a, b) and the position held on each. */
export interface Segment {
  a: number;
  b: number;
  ret: Float64Array;
  held: Float64Array;
}

export function simulate(pr: Float64Array, pos: ArrayLike<number>, a: number, b: number, slippageBps: number): Segment {
  a = Math.max(1, a);
  b = Math.max(a, Math.min(b, pr.length));
  const len = b - a;
  const ret = new Float64Array(len);
  const held = new Float64Array(len);
  const cost = slippageBps / 1e4;
  let prev = 0;
  for (let k = 0; k < len; k++) {
    const p = pos[a + k - 1]!;
    ret[k] = p * pr[a + k]! - cost * Math.abs(p - prev);
    held[k] = p;
    prev = p;
  }
  return { a, b, ret, held };
}

/** Same as simulate on a 0/1 signal, without allocations, straight to the objective. */
export function quickScore(
  pr: Float64Array,
  sig: Uint8Array,
  dirSign: number,
  slippageBps: number,
  a: number,
  b: number,
  objective: Objective,
): number {
  a = Math.max(1, a);
  const cost = slippageBps / 1e4;
  let prev = 0;
  let s = 0;
  let ss = 0;
  let lg = 0;
  let k = 0;
  for (let i = a; i < b; i++) {
    const p = sig[i - 1] ? dirSign : 0;
    const r = p * pr[i]! - cost * Math.abs(p - prev);
    prev = p;
    s += r;
    ss += r * r;
    lg += r > -1 ? Math.log1p(r) : -Infinity;
    k++;
  }
  if (objective === "return") return k ? Math.expm1(lg) : 0;
  if (k < 2) return 0;
  const m = s / k;
  const v = (ss - k * m * m) / (k - 1);
  return v > 1e-18 ? (m / Math.sqrt(v)) * Math.sqrt(365) : 0;
}

/** Share of return days [a, b) in market and trades entered, for a 0/1 signal (a window starts flat, as in simulate). */
export function zoneActivity(sig: Uint8Array, a: number, b: number): { exposure: number; trades: number } {
  a = Math.max(1, a);
  let inMkt = 0;
  let trades = 0;
  let prev = 0;
  for (let i = a; i < b; i++) {
    const s = sig[i - 1]!;
    inMkt += s;
    if (s && !prev) trades++;
    prev = s;
  }
  return { exposure: b > a ? inMkt / (b - a) : 0, trades };
}

export function sharpeOf(ret: ArrayLike<number>): number {
  const k = ret.length;
  if (k < 2) return 0;
  let s = 0;
  for (let i = 0; i < k; i++) s += ret[i]!;
  const m = s / k;
  let ss = 0;
  for (let i = 0; i < k; i++) ss += (ret[i]! - m) ** 2;
  const sd = Math.sqrt(ss / (k - 1));
  return sd > 1e-9 ? (m / sd) * Math.sqrt(365) : 0;
}

export function totalReturnOf(ret: ArrayLike<number>): number {
  let lg = 0;
  for (let i = 0; i < ret.length; i++) lg += ret[i]! > -1 ? Math.log1p(ret[i]!) : -Infinity;
  return Math.expm1(lg);
}

export function objectiveOf(ret: ArrayLike<number>, objective: Objective): number {
  return objective === "return" ? totalReturnOf(ret) : sharpeOf(ret);
}

export function concatReturns(segs: Segment[]): Float64Array {
  const out = new Float64Array(segs.reduce((a, s) => a + s.ret.length, 0));
  let o = 0;
  for (const s of segs) {
    out.set(s.ret, o);
    o += s.ret.length;
  }
  return out;
}

/**
 * Stats over one or more segments read as one track. A trade is a contiguous
 * run of non-zero position inside a segment; it is closed when the position
 * goes flat within the segment, and its net return includes the exit cost
 * charged on that day.
 */
export function perfStats(t: number[], segs: Segment[]): PerfStats {
  const nonEmpty = segs.filter((s) => s.b > s.a);
  const days = nonEmpty.reduce((a, s) => a + s.ret.length, 0);
  const first = nonEmpty[0] ?? segs[0];
  const last = nonEmpty[nonEmpty.length - 1] ?? segs[segs.length - 1];
  const from = first ? isoDate(t[Math.min(first.a, t.length - 1)]!) : "";
  const to = last ? isoDate(t[Math.max(0, Math.min(last.b - 1, t.length - 1))]!) : "";
  let eq = 1;
  let peak = 1;
  let mdd = 0;
  let inMkt = 0;
  let trades = 0;
  let closed = 0;
  let wins = 0;
  for (const s of nonEmpty) {
    let open = false;
    let tradeEq = 1;
    let side = 0;
    for (let k = 0; k < s.ret.length; k++) {
      const r = s.ret[k]!;
      const h = s.held[k]!;
      eq *= 1 + r;
      if (eq > peak) peak = eq;
      mdd = Math.min(mdd, eq / peak - 1);
      const sd = Math.sign(h);
      if (sd !== 0) inMkt++;
      if (open && sd !== side) {
        // Position went flat (or flipped): this day carries the exit cost.
        tradeEq *= 1 + r;
        closed++;
        if (tradeEq > 1) wins++;
        open = false;
        if (sd === 0) continue;
      }
      if (sd !== 0) {
        if (!open) {
          open = true;
          side = sd;
          tradeEq = 1;
          trades++;
        }
        tradeEq *= 1 + r;
      }
    }
  }
  const years = days / 365;
  const totalReturn = eq - 1;
  return {
    from,
    to,
    days,
    totalReturn: fin(totalReturn),
    cagr: days ? (eq > 0 ? fin(eq ** (1 / years) - 1) : -1) : 0,
    sharpe: fin(sharpeOf(concatReturns(nonEmpty))),
    maxDrawdown: fin(mdd),
    hitRate: closed ? wins / closed : null,
    trades,
    tradesPerYear: years > 0 ? trades / years : 0,
    exposure: days ? inMkt / days : 0,
    ...(trades ? {} : { untested: true }),
  };
}

const fin = (x: number) => (Number.isFinite(x) ? x : 0);

/** Equity for the strategy and benchmark over the same segment pair, starting at 1 on day a − 1. */
export function equityCurve(t: number[], strat: Segment, bench: Segment): Array<{ t: number; strategy: number; benchmark: number }> {
  const out = [{ t: t[strat.a - 1]!, strategy: 1, benchmark: 1 }];
  let s = 1;
  let b = 1;
  for (let k = 0; k < strat.ret.length; k++) {
    s *= 1 + strat.ret[k]!;
    b *= 1 + bench.ret[k]!;
    out.push({ t: t[strat.a + k]!, strategy: s, benchmark: b });
  }
  return out;
}
