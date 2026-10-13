import type { PricedIn } from "../../shared/intel.js";
import type { Bar } from "./diff.js";
import type { IntelStore } from "./store.js";

// Priced-in check (SPEC.md § Intel I0.11). Code, no LLM: how far price and
// OI have already moved since the news was first seen. Baseline = the
// nearest snapshot at/after first_seen (within MAX_GAP_MS, so a store that
// only started later does not pose as the "before"); else the close of the
// 1h candle that contains first_seen, with oiPct null (candles carry no OI).
// "Now" = the latest snapshot, else the latest candle close.

export const MAX_GAP_MS = 2 * 3_600_000;
const HOUR_MS = 3_600_000;

type Point = { price: number; oiUsd: number | null };

const pct = (from: number, to: number) => ((to - from) / Math.abs(from)) * 100;
const okNum = (n: number | null | undefined): n is number => typeof n === "number" && Number.isFinite(n);

/** Pure. Null when either price is unusable. */
export function pricedIn(now: Point, base: Point & { ts: string }): PricedIn | null {
  if (!okNum(now.price) || !okNum(base.price) || base.price === 0) return null;
  const oi = okNum(now.oiUsd) && okNum(base.oiUsd) && base.oiUsd !== 0 ? pct(base.oiUsd, now.oiUsd) : null;
  return { pricePct: pct(base.price, now.price), oiPct: oi, since: base.ts };
}

const signed = (n: number, digits: number) => {
  const s = Math.abs(n).toFixed(digits);
  return Number(s) === 0 ? `${s}%` : `${n < 0 ? "−" : "+"}${s}%`;
};

/** "already −4.1%, OI −8%" (OI part omitted when unknown). */
export function pricedInText(p: PricedIn): string {
  return `already ${signed(p.pricePct, 1)}${p.oiPct == null ? "" : `, OI ${signed(p.oiPct, 0)}`}`;
}

export interface PricedInDeps {
  store: Pick<IntelStore, "nearestSnapshot">;
  /** 1h candles, ascending; `t` = candle open (ms). */
  candles1h(coin: string, from: Date, to: Date): Promise<Array<Bar & { t: number }>>;
  now(): Date;
}

/** Loader around `pricedIn`. Never throws: a failing source yields null. */
export async function loadPricedIn(deps: PricedInDeps, asset: string, firstSeen: string): Promise<PricedIn | null> {
  try {
    const now = deps.now();
    const seen = new Date(firstSeen);
    if (!Number.isFinite(seen.getTime()) || seen.getTime() > now.getTime()) return null;
    const [after, latest] = await Promise.all([deps.store.nearestSnapshot(asset, seen, "after"), deps.store.nearestSnapshot(asset, now, "before")]);
    if (after && latest && Date.parse(after.ts) - seen.getTime() <= MAX_GAP_MS) {
      return pricedIn({ price: latest.price, oiUsd: latest.oiUsd }, { price: after.price, oiUsd: after.oiUsd, ts: after.ts });
    }
    const candles = await deps.candles1h(asset, new Date(seen.getTime() - HOUR_MS), now);
    // The candle containing first_seen closes at/after it.
    const base = candles.find((c) => c.t <= seen.getTime() && c.t + HOUR_MS > seen.getTime()) ?? candles.find((c) => c.t >= seen.getTime() && c.t - seen.getTime() <= MAX_GAP_MS);
    if (!base) return null;
    const nowPx = latest?.price ?? candles.at(-1)?.c;
    if (!okNum(nowPx)) return null;
    return pricedIn({ price: nowPx, oiUsd: null }, { price: base.c, oiUsd: null, ts: new Date(base.t + HOUR_MS).toISOString() });
  } catch {
    return null;
  }
}
