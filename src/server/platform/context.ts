import { hlInfo } from "../../shared/hl-client.js";
import type { PlatformStore } from "./store.js";
import { parseMids } from "./ws.js";
import type { NearMiss } from "../../shared/platform.js";

// What /api/platform reads from the running worker (SPEC P0.15, P2): the store,
// live mids with their ages, and the scanner clock. scripts/server.ts sets it at
// boot. Without it, routes use dbPlatformContext (Postgres plus mids fetched from Hyperliquid on demand)
// when a database is configured, else answer 503 platform_offline.

export interface PlatformContext {
  store: PlatformStore;
  midAge(coin: string, now?: number): number | null;   // seconds since last WS mid, null if never
  mid(coin: string): number | null;
  lastScanAt(): Promise<Date | null>;
  /** Near-misses of the latest scan, closest first. */
  nearMisses(): Promise<NearMiss[]>;
  scanIntervalSec: number;
  /** Bring the mids up to date before a freshness check. Absent where a websocket already keeps them live. */
  refreshMids?(now: number): Promise<void>;
}

/** A fetched mid is reused this long, so a poll and the approve that follows it share one request. */
const MID_REUSE_MS = 5_000;

/**
 * The context of a process without the worker (Vercel): reads what the tick persisted, and takes mids from
 * Hyperliquid's `allMids` on demand (refreshMids), so the freshness gate judges a real price age. A failed
 * fetch keeps the last mids, which then age past the gate; before any fetch there is no mid. The scan clock is
 * the near-miss row's timestamp, written at the end of each completed scan.
 */
export function dbPlatformContext(store: PlatformStore, deps: { info?: typeof hlInfo } = {}): PlatformContext {
  const info = deps.info ?? hlInfo;
  let mids = new Map<string, number>();
  let at: number | null = null;
  return {
    store,
    midAge: (coin, now = Date.now()) => (at != null && mids.has(coin) ? Math.max(0, (now - at) / 1000) : null),
    mid: (coin) => mids.get(coin) ?? null,
    lastScanAt: async () => { const r = await store.latestNearMisses(); return r ? new Date(r.ts) : null; },
    nearMisses: async () => (await store.latestNearMisses())?.items ?? [],
    scanIntervalSec: 3600,
    refreshMids: async (now) => {
      if (at != null && now - at < MID_REUSE_MS) return;
      const next = await info<unknown>({ type: "allMids" }).then((d) => parseMids({ mids: d }), () => null);
      if (next && next.size > 0) { mids = next; at = now; }
    },
  };
}

/** P0.15: a mid older than this blocks approval. */
export const MAX_MID_AGE_SEC = 30;

/**
 * The freshness gate of an approval (SPEC P0.15), as one pure function: the reason approval is blocked, or null.
 * The approve route answers 409 stale_feed with this string, and the detail payload exposes it as
 * `approveBlockedReason` / `canApprove`, so the button and the route cannot disagree.
 */
export function approveBlock(q: { coin: string; midAgeSec: number | null; lastScanAt: Date | null; now: number; scanIntervalSec: number }): string | null {
  if (q.midAgeSec == null) return `no live mid for ${q.coin}`;
  if (q.midAgeSec > MAX_MID_AGE_SEC) return `${q.coin} mid is ${Math.round(q.midAgeSec)} s old (limit ${MAX_MID_AGE_SEC} s)`;
  if (!q.lastScanAt || q.now - q.lastScanAt.getTime() > 2 * q.scanIntervalSec * 1000) return "the last scan is older than twice the scan interval";
  return null;
}

/** approveBlock read from a context now. */
export async function approveBlockOf(ctx: PlatformContext, coin: string, now: number): Promise<string | null> {
  await ctx.refreshMids?.(now);
  return approveBlock({ coin, midAgeSec: ctx.midAge(coin, now), lastScanAt: await ctx.lastScanAt(), now, scanIntervalSec: ctx.scanIntervalSec });
}

let ctx: PlatformContext | null = null;
export const setPlatformContext = (c: PlatformContext | null) => { ctx = c; };
export const getPlatformContext = () => ctx;

/**
 * Opportunity ids whose approval is placing at the desk right now (this process). The approve route adds before
 * placement and removes in finally; reconcile.ts leaves these alone. ponytail: in-process, fine for one service.
 */
export const placing = new Set<string>();
/** Desk proposal `decidedBy` for a platform approval: reconcile.ts finds the proposal by it. */
export const placedBy = (opportunityId: string) => `operator (opportunity ${opportunityId})`;
