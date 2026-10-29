// Asset class of a Hyperliquid perp. Main-dex perps are crypto. HIP-3
// builder dexes ("xyz:NVDA") list stocks, ETFs, pre-IPO names, commodities,
// indices, FX and rates under bare tickers with no class field upstream, so
// the class comes from the ticker: the sets below name the non-equity
// tickers seen on HIP-3 dexes, and any other HIP-3 ticker is an equity.

export const ASSET_CLASSES = ["crypto", "equity", "commodity", "index", "fx", "rates"] as const;
export type AssetClass = (typeof ASSET_CLASSES)[number];

const COMMODITY = new Set([
  "GOLD", "SILVER", "COPPER", "PLATINUM", "PALLADIUM", "ALUMINIUM", "URANIUM", "GOLDJM", "SILVERJM",
  "CL", "WTI", "OIL", "USOIL", "BRENTOIL", "NATGAS", "GAS", "HO", "TTF", "USENERGY",
  "CORN", "WHEAT", "SOY",
]);
const INDEX = new Set([
  "SP500", "US500", "USA500", "USA100", "USTECH", "XYZ100", "SMALL2000", "JP225", "KR200", "NIFTY", "IBOV",
  "MAG7", "MAGS", "VIX", "VOL", "BVIV", "BTCD", "TOTAL2", "OTHERS",
  "SEMIS", "SEMI", "BIOTECH", "DEFENSE", "ENERGY", "INFOTECH", "NUCLEAR", "ROBOT",
]);
const FX = new Set(["EUR", "GBP", "JPY", "KRW", "DXY"]);
const RATES = new Set(["2Y", "10Y", "30Y", "USBOND", "TLT"]);
// Crypto listed on HIP-3 dexes (e.g. HyENA margins majors in USDe).
const CRYPTO = new Set([
  "BTC", "ETH", "SOL", "HYPE", "XRP", "BNB", "DOGE", "ADA", "BCH", "LTC", "LINK", "SUI", "ENA", "ZEC", "XMR",
  "PUMP", "FARTCOIN", "IP", "LIGHTER", "LIT", "XPL", "BASED", "USDE",
]);

/** Dex prefix of a coin name: "" for the main dex, "xyz" for "xyz:NVDA". */
export function dexOf(coin: string): string {
  const i = coin.indexOf(":");
  return i < 0 ? "" : coin.slice(0, i);
}

/** Ticker without the dex prefix. */
export function tickerOf(coin: string): string {
  const i = coin.indexOf(":");
  return i < 0 ? coin : coin.slice(i + 1);
}

export function assetClass(coin: string): AssetClass {
  if (!coin.includes(":")) return "crypto";
  const t = tickerOf(coin).toUpperCase();
  if (CRYPTO.has(t)) return "crypto";
  if (COMMODITY.has(t)) return "commodity";
  if (INDEX.has(t)) return "index";
  if (FX.has(t)) return "fx";
  if (RATES.has(t)) return "rates";
  return "equity";
}
