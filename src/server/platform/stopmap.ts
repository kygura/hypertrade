import { z } from "zod";
import { bucketIndex, type LiqCell } from "../../shared/platform.js";

// Stop map (docs/SPEC.md § stopmap): resting stop orders of crawled wallets, from HL info frontendOpenOrders. Liquidation
// prices show leverage; stops show intent, and they sit just past the obvious levels. Pure.

const Num = z.union([z.string(), z.number()]).transform(Number).pipe(z.number().finite());
const RawOrder = z.object({
  coin: z.string().min(1),
  /** A = ask (sell), B = bid (buy). */
  side: z.enum(["A", "B"]),
  sz: Num,
  triggerPx: Num,
  isTrigger: z.boolean(),
  orderType: z.string(),
  reduceOnly: z.boolean().optional(),
  isPositionTpsl: z.boolean().optional(),
});

export interface StopOrder {
  coin: string;
  /** The position the stop closes: a sell stop closes a long, a buy stop a short. */
  closes: "long" | "short";
  triggerPx: number;
  /** Order size in coins; 0 on a position TP/SL, which closes the whole position. */
  sz: number;
}

/**
 * The reduce-only stops ("Stop Market", "Stop Limit", position stop-losses) in a frontendOpenOrders response. Take
 * profits, plain limits and non-reduce-only triggers (a stop entry opens a position, it clears none) are dropped. Bad
 * rows are skipped and counted, never thrown; null when the envelope is not an array.
 */
export function parseStopOrders(raw: unknown): { stops: StopOrder[]; bad: number } | null {
  if (!Array.isArray(raw)) return null;
  const stops: StopOrder[] = [];
  let bad = 0;
  for (const row of raw) {
    const r = RawOrder.safeParse(row);
    if (!r.success) {
      bad++;
      continue;
    }
    const o = r.data;
    if (!o.isTrigger || !o.orderType.startsWith("Stop") || !(o.reduceOnly || o.isPositionTpsl) || !(o.triggerPx > 0) || o.sz < 0) continue;
    stops.push({ coin: o.coin, closes: o.side === "A" ? "long" : "short", triggerPx: o.triggerPx, sz: o.sz });
  }
  return { stops, bad };
}

/**
 * One coin's stops on the liqmap grid: notional = size × trigger price (a whole-position stop takes the wallet's
 * position size from `positionSz`). Long stops below mark, short stops above it, within mark × (1 ± rangePct); a
 * stop on the wrong side of mark is about to fire or stale and is dropped. Cells sorted by idx.
 */
export function bucketStops(
  stops: Array<StopOrder & { positionSz?: number | null }>,
  o: { mark: number; bucketBps: number; rangePct: number },
): LiqCell[] {
  const { mark, bucketBps, rangePct } = o;
  const cells = new Map<number, LiqCell>();
  for (const s of stops) {
    const px = s.triggerPx;
    if (px < mark * (1 - rangePct) || px > mark * (1 + rangePct)) continue;
    if (s.closes === "long" ? px >= mark : px <= mark) continue;
    const size = s.sz > 0 ? s.sz : Math.abs(s.positionSz ?? 0);
    if (!(size > 0)) continue;
    const idx = bucketIndex(px, bucketBps);
    const c = cells.get(idx) ?? { idx, longUsd: 0, shortUsd: 0 };
    if (s.closes === "long") c.longUsd += size * px;
    else c.shortUsd += size * px;
    cells.set(idx, c);
  }
  return [...cells.values()].sort((a, b) => a.idx - b.idx);
}
