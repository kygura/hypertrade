import { createHlShare, hlInfo, parseMetaAndCtxs } from "../../shared/hl-client.js";
import { LIQMAP_BUCKET_BPS, type Position, type StopMapSnapshot } from "../../shared/platform.js";
import type { LoopDef } from "./runtime.js";
import { envNum, type Info } from "./scanner.js";
import { bucketStops, parseStopOrders, type StopOrder } from "./stopmap.js";
import type { PlatformStore } from "./store.js";

// Stop map loop (docs/SPEC.md § stopmap): every 15 min, the wallets the crawler holds a position for in a top
// PLATFORM_LIQMAP_COINS coin (largest first, at most PLATFORM_STOPMAP_WALLETS) are asked for their open orders
// (frontendOpenOrders, weight 20). Their reduce-only stops go on the liqmap grid, one stopmap_snapshots row per coin.
// The loop has its own share of the hlInfo weight guard (PLATFORM_STOPMAP_WEIGHT_PER_MIN), so the scanner and the
// crawler never starve behind it. It sees only crawled wallets' stops: read it with the liqmap's coverage ratio.

/** HL weighs frontendOpenOrders at the default 20 (hl-client responseWeight agrees). */
const ORDERS_WEIGHT = 20;
const RANGE = 0.3;

/** The wallets to poll: those holding a position in `coins`, by their notional in them, largest first. */
export function walletsToPoll(positions: Position[], coins: ReadonlySet<string>, max: number): string[] {
  const sum = new Map<string, number>();
  for (const p of positions) if (coins.has(p.coin)) sum.set(p.address, (sum.get(p.address) ?? 0) + p.positionValue);
  return [...sum].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, max).map(([a]) => a);
}

export function createStopmapLoop(deps: {
  store: Pick<PlatformStore, "listPositions" | "insertStopmapSnapshots">;
  info?: Info;
  now?: () => number;
  coins?: number;
  wallets?: number;
  /** Waits for this loop's share of the weight guard; default createHlShare(PLATFORM_STOPMAP_WEIGHT_PER_MIN). */
  share?: (weight: number) => Promise<void>;
}) {
  const { store } = deps;
  const info = deps.info ?? hlInfo;
  const now = deps.now ?? Date.now;
  const topN = deps.coins ?? envNum("PLATFORM_LIQMAP_COINS", 30);
  const maxWallets = deps.wallets ?? envNum("PLATFORM_STOPMAP_WALLETS", 100);
  const share = deps.share ?? createHlShare(envNum("PLATFORM_STOPMAP_WEIGHT_PER_MIN", 150));

  async function tick(): Promise<StopMapSnapshot[]> {
    const { ctxs } = parseMetaAndCtxs(await info<unknown>({ type: "metaAndAssetCtxs" }));
    const top = ctxs
      .filter((c) => !c.isDelisted && c.markPx > 0 && Number.isFinite(c.markPx * c.openInterest))
      .sort((a, b) => b.openInterest * b.markPx - a.openInterest * a.markPx)
      .slice(0, topN);
    const coins = new Set(top.map((c) => c.name));
    const positions = await store.listPositions();
    const wallets = walletsToPoll(positions, coins, maxWallets);
    const sz = new Map(positions.map((p) => [`${p.address}|${p.coin}`, p.szi]));
    const stops: Array<StopOrder & { positionSz: number | null }> = [];
    const polled = new Map<string, number>(); // coin → polled wallets holding it
    let failed = 0;
    for (const w of wallets) {
      await share(ORDERS_WEIGHT);
      const parsed = await info<unknown>({ type: "frontendOpenOrders", user: w }).then(parseStopOrders, () => null);
      if (!parsed) {
        failed++;
        continue;
      }
      for (const c of coins) if (sz.has(`${w}|${c}`)) polled.set(c, (polled.get(c) ?? 0) + 1);
      for (const s of parsed.stops) if (coins.has(s.coin)) stops.push({ ...s, positionSz: sz.get(`${w}|${s.coin}`) ?? null });
    }
    if (wallets.length >= 5 && failed / wallets.length > 0.8) throw new Error(`stopmap: ${failed}/${wallets.length} order polls failed`);
    const ts = new Date(now()).toISOString();
    const rows = top.flatMap((c): StopMapSnapshot[] => {
      const n = polled.get(c.name) ?? 0;
      if (!n) return [];
      const buckets = bucketStops(stops.filter((s) => s.coin === c.name), { mark: c.markPx, bucketBps: LIQMAP_BUCKET_BPS, rangePct: RANGE });
      return [{ coin: c.name, ts, mark: c.markPx, bucketBps: LIQMAP_BUCKET_BPS, buckets, wallets: n }];
    });
    if (rows.length) await store.insertStopmapSnapshots(rows);
    return rows;
  }

  return { tick, def: { name: "stopmap", intervalSec: 15 * 60, run: async () => void (await tick()) } satisfies LoopDef };
}
