import type { PlatformStore } from "./store.js";

// What /api/platform reads from the running worker (SPEC P0.15, P2): the store,
// live mids with their ages, and the scanner clock. scripts/server.ts sets it at
// boot; routes answer 503 platform_offline while it is null (Vercel, API-only).

export interface PlatformContext {
  store: PlatformStore;
  midAge(coin: string, now?: number): number | null;   // seconds since last WS mid, null if never
  mid(coin: string): number | null;
  lastScanAt(): Date | null;
  scanIntervalSec: number;
}
let ctx: PlatformContext | null = null;
export const setPlatformContext = (c: PlatformContext | null) => { ctx = c; };
export const getPlatformContext = () => ctx;
