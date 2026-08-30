// Backfills the `candles` table for a branch's coins from CoinGecko (primary)
// and Hyperliquid candleSnapshot (fallback for perp-listed coins CoinGecko
// doesn't cover). Stablecoins are a constant $1 and are never backfilled.
import * as db from "../db";
import type { Candle } from "../db";
import { fetchCandles as fetchHlCandles } from "../../shared/hl-client";
import type { BranchConfig } from "../../shared/types";

const DAY_MS = 86400000;
const STABLES = new Set(["USDC", "USDT"]);
const TF = "1d";

// Hyperliquid symbol -> CoinGecko coin id, ported from hyperion's
// internal/marketdata/coingecko.go DefaultIDs (29 entries).
export const COINGECKO_IDS: Record<string, string> = {
  BTC: "bitcoin",
  ETH: "ethereum",
  SOL: "solana",
  HYPE: "hyperliquid",
  ARB: "arbitrum",
  OP: "optimism",
  AVAX: "avalanche-2",
  MATIC: "matic-network",
  DOGE: "dogecoin",
  LINK: "chainlink",
  SUI: "sui",
  APT: "aptos",
  TIA: "celestia",
  INJ: "injective-protocol",
  SEI: "sei-network",
  WLD: "worldcoin-wld",
  PEPE: "pepe",
  WIF: "dogwifcoin",
  BNB: "binancecoin",
  XRP: "ripple",
  BONK: "bonk",
  PENDLE: "pendle",
  ENA: "ethena",
  JUP: "jupiter-exchange-solana",
  NEAR: "near",
  PYTH: "pyth-network",
  W: "wormhole",
  ONDO: "ondo-finance",
  ETHFI: "ether-fi",
  EIGEN: "eigenlayer",
};

/** True when stored `1d` coverage doesn't span [startDate, ~today] yet. */
export function needsBackfill(coverage: { min: Date; max: Date } | null, startDate: Date, today: Date): boolean {
  if (!coverage) return true;
  if (coverage.min.getTime() > startDate.getTime()) return true;
  if (today.getTime() - coverage.max.getTime() > DAY_MS) return true;
  return false;
}

/** CoinGecko's free OHLC endpoint only takes a fixed `days` bucket. */
export function daysParam(startDate: Date, today: Date): 365 | "max" {
  return today.getTime() - startDate.getTime() <= 365 * DAY_MS ? 365 : "max";
}

async function fetchCoinGeckoOhlc(
  coin: string,
  id: string,
  days: 365 | "max",
  fetchFn: typeof fetch,
): Promise<Candle[] | null> {
  try {
    const r = await fetchFn(`https://api.coingecko.com/api/v3/coins/${id}/ohlc?vs_currency=usd&days=${days}`);
    if (!r.ok) return null;
    const raw = (await r.json()) as [number, number, number, number, number][];
    return raw.map(([t, o, h, l, c]) => ({ coin, tf: TF, ts: new Date(t!), o: o!, h: h!, l: l!, c: c!, v: null }));
  } catch {
    return null; // network hiccup -> caller falls back to Hyperliquid
  }
}

async function fetchHyperliquidDaily(coin: string, startMs: number, fetchFn: typeof fetch): Promise<Candle[]> {
  const raw = await fetchHlCandles(coin, "1d", startMs, Date.now(), fetchFn);
  return raw.map((c) => ({ coin, tf: TF, ts: new Date(c.t), o: c.o, h: c.h, l: c.l, c: c.c, v: c.v }));
}

/** Ensures daily candle coverage for one coin, CoinGecko first, Hyperliquid
 * candleSnapshot as fallback. No-op for stablecoins and for coins already covered. */
export async function backfillCoin(coin: string, startDate: Date, fetchFn: typeof fetch = fetch): Promise<void> {
  if (STABLES.has(coin)) return;
  const today = new Date();
  const coverage = await db.candleCoverage(coin, TF);
  if (!needsBackfill(coverage, startDate, today)) return;

  const cgId = COINGECKO_IDS[coin];
  const rows = cgId ? await fetchCoinGeckoOhlc(coin, cgId, daysParam(startDate, today), fetchFn) : null;
  const finalRows = rows && rows.length > 0 ? rows : await fetchHyperliquidDaily(coin, startDate.getTime(), fetchFn);
  if (finalRows.length > 0) await db.upsertCandles(finalRows);
}

/** Backfills every non-stable coin in a branch's allocations, sequentially
 * (rate-limit courtesy — no parallel fetch storm against CoinGecko's free tier). */
export async function backfillBranch(config: BranchConfig, fetchFn: typeof fetch = fetch): Promise<void> {
  const startDate = new Date(config.startDate);
  for (const a of config.allocations) {
    await backfillCoin(a.coin, startDate, fetchFn);
  }
}
