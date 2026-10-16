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

/** direction × (horizonPx/entryPx − 1) minus round-trip fees, slippage and funding (bps). Throws on non-positive prices. */
export function netReturn(a: { direction: Opportunity["direction"]; entryPx: number; horizonPx: number; costs: Pick<Costs, "feeBps" | "slippageBps" | "fundingBps"> }): number {
  if (!(a.entryPx > 0) || !(a.horizonPx > 0) || !Number.isFinite(a.entryPx) || !Number.isFinite(a.horizonPx)) throw new Error("prices must be finite and positive");
  const sign = a.direction === "long" ? 1 : -1;
  const { feeBps, slippageBps, fundingBps } = a.costs;
  return sign * (a.horizonPx / a.entryPx - 1) - (2 * feeBps + slippageBps + fundingBps) / 1e4;
}
