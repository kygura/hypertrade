import type { PlatformStore } from "./store.js";
import type { NearMiss } from "../../shared/platform.js";

// What /api/platform reads from the running worker (SPEC P0.15, P2): the store,
// live mids with their ages, and the scanner clock. scripts/server.ts sets it at
// boot; routes answer 503 platform_offline while it is null (Vercel, API-only).

export interface PlatformContext {
  store: PlatformStore;
  midAge(coin: string, now?: number): number | null;   // seconds since last WS mid, null if never
  mid(coin: string): number | null;
  lastScanAt(): Date | null;
  /** Near-misses of the latest scan, closest first. */
  nearMisses(): NearMiss[];
  scanIntervalSec: number;
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
