import type { PlatformStore } from "./store.js";
import type { NearMiss } from "../../shared/platform.js";

// What /api/platform reads from the running worker (SPEC P0.15, P2): the store,
// live mids with their ages, and the scanner clock. scripts/server.ts sets it at
// boot. Without it, routes use dbPlatformContext (Postgres only, no live mids) when a database
// is configured, else answer 503 platform_offline.

export interface PlatformContext {
  store: PlatformStore;
  midAge(coin: string, now?: number): number | null;   // seconds since last WS mid, null if never
  mid(coin: string): number | null;
  lastScanAt(): Promise<Date | null>;
  /** Near-misses of the latest scan, closest first. */
  nearMisses(): Promise<NearMiss[]>;
  scanIntervalSec: number;
}
/**
 * The context of a process without the worker (Vercel): reads only what the tick persisted. No live mids,
 * so approval stays blocked by the freshness gate (409 stale_feed). The scan clock is the near-miss row's
 * timestamp, written at the end of each completed scan.
 */
export const dbPlatformContext = (store: PlatformStore): PlatformContext => ({
  store,
  midAge: () => null,
  mid: () => null,
  lastScanAt: async () => { const r = await store.latestNearMisses(); return r ? new Date(r.ts) : null; },
  nearMisses: async () => (await store.latestNearMisses())?.items ?? [],
  scanIntervalSec: 3600,
});

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
