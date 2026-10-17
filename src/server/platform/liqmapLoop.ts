import { hlInfo, parseMetaAndCtxs } from "../../shared/hl-client.js";
import type { Position } from "../../shared/platform.js";
import { aggregate } from "./liqmap.js";
import type { LoopDef } from "./runtime.js";
import { envNum, type Info } from "./scanner.js";
import type { PlatformStore } from "./store.js";

// Liqmap snapshot loop (SPEC P0.4 liqmap, P0.7): every 15 min, the top PLATFORM_LIQMAP_COINS by
// OI notional get one bucketed snapshot on the fixed log grid.

export const LIQMAP_BUCKET_BPS = 25;
/** Half-width of the stored grid around mark. The live route and history view slice it narrower. */
export const LIQMAP_RANGE = 0.3;

export function createLiqmapLoop(deps: { store: PlatformStore; info?: Info; now?: () => number; coins?: number }) {
  const { store } = deps;
  const info = deps.info ?? hlInfo;
  const now = deps.now ?? Date.now;
  const topN = deps.coins ?? envNum("PLATFORM_LIQMAP_COINS", 30);

  async function tick() {
    const { ctxs } = parseMetaAndCtxs(await info<unknown>({ type: "metaAndAssetCtxs" }));
    const top = ctxs
      .filter((c) => !c.isDelisted && c.markPx > 0 && Number.isFinite(c.markPx * c.openInterest))
      .sort((a, b) => b.openInterest * b.markPx - a.openInterest * a.markPx)
      .slice(0, topN);
    const byCoin = new Map<string, Position[]>();
    for (const p of await store.listPositions()) (byCoin.get(p.coin) ?? byCoin.set(p.coin, []).get(p.coin)!).push(p);
    const ts = new Date(now()).toISOString();
    const rows = top.flatMap((c) => {
      const { buckets } = aggregate(byCoin.get(c.name) ?? [], { mark: c.markPx, bucketBps: LIQMAP_BUCKET_BPS, rangePct: LIQMAP_RANGE });
      // ponytail: a coin with no tracked liquidations stores no row; the history view treats a gap as empty.
      return buckets.length ? [{ coin: c.name, ts, mark: c.markPx, bucketBps: LIQMAP_BUCKET_BPS, buckets: buckets.map(({ idx, longUsd, shortUsd }) => ({ idx, longUsd, shortUsd })) }] : [];
    });
    if (rows.length) await store.insertLiqmapSnapshots(rows);
  }

  return { tick, def: { name: "liqmap", intervalSec: 15 * 60, run: tick } satisfies LoopDef };
}
