import type { PlatformStore } from "./store";
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
