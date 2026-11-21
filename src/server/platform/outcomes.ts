import type { Candle } from "../../shared/types.js";
import { barTouch } from "../../shared/firstTouch.js";
import { HorizonSchema, type Costs, type Opportunity } from "../../shared/platform.js";

const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

/** "1h,4h,24h,72h" → ["1h","4h","24h","72h"]. Throws on a malformed or zero horizon. */
export function parseHorizons(s: string): string[] {
  const hs = s.split(",").map((h) => HorizonSchema.parse(h.trim()));
  for (const h of hs) if (horizonMs(h) <= 0) throw new Error(`invalid horizon ${h}`);
  return hs;
}

export const horizonMs = (h: string) => Number(h.slice(0, -1)) * UNIT_MS[h.slice(-1) as keyof typeof UNIT_MS];

/** Horizons whose time has come (inclusive) and that are not marked yet. */
export function dueHorizons(createdAt: string, horizons: string[], alreadyMarked: string[], now: Date): string[] {
  const t = Date.parse(createdAt);
  if (!Number.isFinite(t)) return [];
  return horizons.filter((h) => !alreadyMarked.includes(h) && now.getTime() - t >= horizonMs(h));
}

/** direction × (horizonPx/entryPx − 1) minus round-trip fees, slippage and funding, as a fraction (0.01 = 1%). Throws on non-positive prices. */
export function netReturn(a: { direction: Opportunity["direction"]; entryPx: number; horizonPx: number; costs: Pick<Costs, "feeBps" | "slippageBps" | "fundingBps"> }): number {
  if (!(a.entryPx > 0) || !(a.horizonPx > 0) || !Number.isFinite(a.entryPx) || !Number.isFinite(a.horizonPx)) throw new Error("prices must be finite and positive");
  const sign = a.direction === "long" ? 1 : -1;
  const { feeBps, slippageBps, fundingBps } = a.costs;
  return sign * (a.horizonPx / a.entryPx - 1) - (2 * feeBps + slippageBps + fundingBps) / 1e4;
}

/**
 * The trade as ticketed, on a candle path (pure): the first touch of the stop or the target in the candles opening
 * in [fromMs, toMs), by shared/firstTouch.ts barTouch (stop wins inside one bar; a gap through the stop fills at the
 * open); with neither touched it leaves at `horizonPx` at `toMs`. Null when the levels do not bracket the entry (a
 * stop at or past the entry has no risk to measure R in).
 */
export function tradeExit(a: {
  direction: Opportunity["direction"]; entryPx: number; stopPx: number; targetPx: number; candles: readonly Candle[]; fromMs: number; toMs: number; horizonPx: number;
}): { exit: "stop" | "target" | "horizon"; exitPx: number; exitAtMs: number; ambiguous: boolean } | null {
  const dir = a.direction === "long" ? 1 : -1;
  if (!(dir * (a.entryPx - a.stopPx) > 0) || !(dir * (a.targetPx - a.entryPx) > 0)) return null;
  const path = a.candles.filter((c) => c.t >= a.fromMs && c.t < a.toMs && [c.o, c.h, c.l].every((x) => Number.isFinite(x) && x > 0)).sort((x, y) => x.t - y.t);
  for (const c of path) {
    const touch = barTouch(dir, a.stopPx, a.targetPx, c);
    if (touch) return { exit: touch.exit, exitPx: touch.px, exitAtMs: Math.min(c.T, a.toMs), ambiguous: touch.ambiguous };
  }
  return { exit: "horizon", exitPx: a.horizonPx, exitAtMs: a.toMs, ambiguous: false };
}
