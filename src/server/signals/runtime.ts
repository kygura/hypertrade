import { databaseUrl } from "../db.js";
import { monitoringWatchlist, watchedAssets } from "../intel/positions.js";
import { PgIntelStore } from "../intel/store.js";
import { STUDY_MAX_COINS } from "../lab/service.js";
import { getLabService } from "../lab/tools.js";
import { createDefinitionScanner, SCAN_DEADLINE_MS, type DefinitionScanner } from "./scan.js";

// The process's definition scan (docs/RESEARCH.md "Signals v2" S2): the Lab service's dataset loader (and its
// caches) over the Lab's default universe plus the monitoring watchlist. Shared by the board and `bun run signals:scan`.

/**
 * Without a database every coin's history is fetched live: price and volume from Hyperliquid candles (one request),
 * funding from Hyperliquid's hourly settlements under the weight guard (about 100 days for funding z(90), five pages
 * a coin on the first scan, then only the new settlements: the ht provider keeps them in process), OI from OKX.
 * The first scan takes minutes, so coins get this long instead of SCAN_DEADLINE_MS.
 */
export const LIVE_SCAN_DEADLINE_MS = 45 * 60_000;

/** The Lab's default universe (top STUDY_MAX_COINS by day volume) plus the monitoring watchlist. */
export async function definitionScanCoins(env: Record<string, string | undefined> = process.env): Promise<string[]> {
  const top = await getLabService().deps.perpUniverse!({ top: STUDY_MAX_COINS });
  const watch = databaseUrl() ? await watchedAssets(new PgIntelStore(), env) : monitoringWatchlist(null, env).items.map((i) => i.asset);
  return [...top, ...watch];
}

/** A scanner over the process's loader and coins; `deadlineMs` defaults by whether a database is configured. */
export function processDefinitionScanner(env: Record<string, string | undefined> = process.env, deadlineMs?: number): DefinitionScanner {
  return createDefinitionScanner({
    loadDataset: (cfg) => getLabService().deps.loadDataset(cfg),
    coins: () => definitionScanCoins(env),
    now: Date.now,
    deadlineMs: deadlineMs ?? (databaseUrl() ? SCAN_DEADLINE_MS : LIVE_SCAN_DEADLINE_MS),
  });
}

/**
 * What the board's `definition` source shows. With a database: the day's scan, awaited (the board bounds the wait
 * with its source timeout). Without one: the scan runs in the background and is never awaited; the last finished scan
 * is served, and null (the caller says "first scan in progress") until there is one.
 */
export async function boardDefinitionScan(scanner: DefinitionScanner, hasDb: boolean) {
  if (hasDb) return scanner.scan();
  scanner.scan().catch((err) => console.warn(`[signals] background definition scan failed: ${err instanceof Error ? err.message : String(err)}`));
  return scanner.latest();
}
