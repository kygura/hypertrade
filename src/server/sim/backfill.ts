// Daily candles for the simulator. Delegates to the chart sync engine
// (market/candleSync.ts): Hyperliquid daily bars, then Binance and Bitstamp
// below HL's listing, so a branch starting in 2019 has real daily history.
// This replaced CoinGecko's free OHLC endpoint, which returns 4-day bars for
// any range over 30 days. Stablecoins are a constant $1 and never backfilled.
import type { BranchConfig } from "../../shared/types.js";
import { ensureHistory, type SyncDeps } from "../market/candleSync.js";

export const STABLES = new Set(["USDC", "USDT"]);

/** Ensures daily candle coverage for one coin from startDate to today. No-op for stablecoins. */
export async function backfillCoin(coin: string, startDate: Date, deps?: SyncDeps, deadline?: number): Promise<void> {
  if (STABLES.has(coin)) return;
  await ensureHistory(coin, "1d", startDate.getTime(), deps, { deadline });
}

/** Backfills every non-stable coin in a branch's allocations and DCA legs, sequentially
 * (rate-limit courtesy — no parallel fetch storm against public APIs). */
export async function backfillBranch(config: BranchConfig, deps?: SyncDeps, deadline?: number): Promise<void> {
  const startDate = new Date(config.startDate);
  const coins = new Set([...config.allocations.map((a) => a.coin), ...(config.dca ?? []).map((d) => d.coin)]);
  for (const coin of coins) {
    await backfillCoin(coin, startDate, deps, deadline);
  }
}
