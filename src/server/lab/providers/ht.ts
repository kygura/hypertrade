import { fetchCandles, fetchFundingPage, HL_FUNDING_PAGE, HL_MAX_CANDLES, type FundingPoint } from "../../../shared/hl-client.js";
import { FRED_SERIES } from "../../collectors/fred.js";
import { databaseUrl, getCandles, getFunding, seriesRange } from "../../db.js";
import { ensureHistory } from "../../market/candleSync.js";
import { DAY_MS, type DailySeries, type LabProvider, type MetricCategory, type MetricDef } from "../types.js";
import { clip, toDaily, type Agg } from "./series.js";

// Hypertrade's own data: Postgres (candles, funding, collector observations)
// with live Hyperliquid fallback for price and funding when there is no DB.
// Stored series only reach back to when collection started.

const HOUR_MS = 3_600_000;
const ENSURE_MS = 8_000;
const ENSURE_TTL_MS = 10 * 60_000;
const LIVE_FUNDING_PAGES = 24; // × 500 hourly rows ≈ 500 days

export interface Ohlcv {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

/** Everything ht touches, injectable so tests never need a DB or network. */
export interface HtDeps {
  hasDb(): boolean;
  /** Best-effort backfill of stored 1d candles down to fromMs. Never throws. */
  ensureHistory(coin: string, fromMs: number): Promise<void>;
  /** Stored 1d candles with t >= fromMs, ascending. */
  candles(coin: string, fromMs: number): Promise<Ohlcv[]>;
  /** Stored hourly funding settlements in [fromMs, toMs]. */
  funding(coin: string, fromMs: number, toMs: number): Promise<FundingPoint[]>;
  /** Stored observations of one series in [fromMs, toMs]. */
  series(id: string, fromMs: number, toMs: number): Promise<Array<{ t: number; v: number }>>;
  liveCandles(coin: string, fromMs: number, toMs: number): Promise<Ohlcv[]>;
  liveFunding(coin: string, fromMs: number, toMs: number): Promise<FundingPoint[]>;
}

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T | void> =>
  Promise.race([p, new Promise<void>((r) => setTimeout(r, ms))]);

export const defaultHtDeps: HtDeps = {
  hasDb: () => Boolean(databaseUrl()),
  async ensureHistory(coin, fromMs) {
    const deadline = Date.now() + ENSURE_MS;
    await withTimeout(ensureHistory(coin, "1d", fromMs, undefined, { deadline }), ENSURE_MS + 2_000).catch(() => {});
  },
  async candles(coin, fromMs) {
    return (await getCandles(coin, "1d", new Date(fromMs))).map((c) => ({
      t: new Date(c.ts).getTime(),
      o: Number(c.o),
      h: Number(c.h),
      l: Number(c.l),
      c: Number(c.c),
      v: Number(c.v ?? 0),
    }));
  },
  async funding(coin, fromMs, toMs) {
    return (await getFunding(coin, new Date(fromMs), new Date(toMs))).map((r) => ({
      t: new Date(r.ts).getTime(),
      rate: Number(r.rate),
      premium: Number(r.premium),
    }));
  },
  async series(id, fromMs, toMs) {
    return (await seriesRange(id, new Date(fromMs), new Date(toMs))).map((p) => ({ t: new Date(p.ts).getTime(), v: Number(p.value) }));
  },
  async liveCandles(coin, fromMs, toMs) {
    // HL keeps only the latest 5000 bars per interval.
    return fetchCandles(coin, "1d", Math.max(fromMs, toMs - HL_MAX_CANDLES * DAY_MS), toMs);
  },
  async liveFunding(coin, fromMs, toMs) {
    const out: FundingPoint[] = [];
    let cursor = Math.max(fromMs, toMs - LIVE_FUNDING_PAGES * HL_FUNDING_PAGE * HOUR_MS);
    for (let page = 0; page < LIVE_FUNDING_PAGES && cursor < toMs; page++) {
      const rows = await fetchFundingPage(coin, cursor, toMs);
      out.push(...rows);
      if (rows.length < HL_FUNDING_PAGE) break;
      cursor = rows[rows.length - 1]!.t + 1;
    }
    return out;
  },
};

type Def = [key: string, name: string, category: MetricCategory, units: string, description: string];

const ASSET_DEFS: Def[] = [
  ["price", "Price", "price", "USD", "Daily close: Hyperliquid perp, stitched with Binance/Bitstamp spot below HL's history."],
  ["volume", "Volume", "price", "USD", "Daily volume × close (approximate USD notional)."],
  ["range", "Daily range", "price", "fraction", "(high − low) / close."],
  ["funding", "Funding (daily)", "derivatives", "fraction/day", "Sum of the day's hourly Hyperliquid funding rates."],
  ["premium", "Premium", "derivatives", "fraction", "Daily mean of Hyperliquid's sampled mark/oracle premium."],
  ["oi", "Open interest", "derivatives", "USD", "Hyperliquid open interest (collector snapshots, last per day)."],
  ["elfa_mentions", "Social mentions", "social", "mentions", "Elfa trailing-24h mentions (collector snapshots, last per day)."],
  ["elfa_share", "Social share", "social", "fraction", "Share of Elfa trending-token mentions, trailing 24h (last per day)."],
];

/** Global metrics backed by one stored observation series: [...def, seriesId, lagDays]. */
type GlobalDef = [...Def, seriesId: string, lagDays: number];
const GLOBAL: GlobalDef[] = [
  ["fng", "Fear & Greed (stored)", "sentiment", "index", "alternative.me Fear & Greed, as collected.", "fng.value", 0],
  ["btc_dominance", "BTC dominance", "macro", "%", "BTC share of total crypto market cap (CoinGecko).", "cg.btc_dominance", 0],
  ["total_mcap", "Total crypto market cap", "liquidity", "USD", "Total crypto market cap (CoinGecko).", "cg.total_mcap_usd", 0],
  ["stablecoin_cap", "Stablecoin cap (stored)", "liquidity", "USD", "USD-pegged stablecoin cap (DefiLlama), as collected.", "llama.stablecoin_cap_usd", 0],
  ["dvol", "BTC DVOL", "derivatives", "index", "Deribit BTC implied volatility index.", "deribit.btc_dvol", 0],
  // FRED observations are stamped with their data date and published a day or more later.
  ...[...FRED_SERIES, "net_liquidity", "spread_2s10s"].map(
    (id): GlobalDef => [`fred.${id}`, `FRED ${id}`, "macro", "", `FRED series ${id}, as collected.`, `fred.${id}`, 1],
  ),
];

/** Stored series id per asset metric (observations), with its daily aggregation. */
const ASSET_SERIES: Record<string, (coin: string) => string> = {
  oi: (c) => `hl.oi.${c}`,
  elfa_mentions: (c) => `elfa.mentions_24h.${c}`,
  elfa_share: (c) => `elfa.share_24h.${c}`,
};

const METRICS: MetricDef[] = [
  ...ASSET_DEFS.map(([key, name, category, units, description]): MetricDef => ({
    id: `ht:${key}`,
    provider: "ht",
    key,
    name,
    category,
    scope: "asset",
    units,
    description,
    lagDays: 0,
  })),
  ...GLOBAL.map(([key, name, category, units, description, , lagDays]): MetricDef => ({
    id: `ht:${key}`,
    provider: "ht",
    key,
    name,
    category,
    scope: "global",
    ...(units ? { units } : {}),
    description,
    lagDays,
  })),
];
const GLOBAL_SERIES = new Map(GLOBAL.map((g) => [g[0], g[5]]));

/** HL coin names are uppercase except the k-prefixed thousands (kPEPE). */
export const htCoin = (asset: string): string => (/^k[A-Z]/.test(asset) ? asset : asset.toUpperCase());

export function createHtProvider(deps: HtDeps = defaultHtDeps): LabProvider {
  const ensured = new Map<string, { fromMs: number; at: number; p: Promise<void> }>();

  function ensure(coin: string, fromMs: number): Promise<void> {
    const prev = ensured.get(coin);
    if (prev && prev.fromMs <= fromMs && Date.now() - prev.at < ENSURE_TTL_MS) return prev.p;
    const p = deps.ensureHistory(coin, fromMs).catch(() => {});
    ensured.set(coin, { fromMs, at: Date.now(), p });
    return p;
  }

  async function candles(coin: string, fromMs: number, toMs: number): Promise<Ohlcv[]> {
    if (deps.hasDb()) {
      await ensure(coin, fromMs);
      const stored = await deps.candles(coin, fromMs).catch(() => []);
      if (stored.length) return stored;
    }
    return deps.liveCandles(coin, fromMs, toMs);
  }

  async function funding(coin: string, fromMs: number, toMs: number): Promise<FundingPoint[]> {
    if (deps.hasDb()) {
      const stored = await deps.funding(coin, fromMs, toMs).catch(() => []);
      if (stored.length) return stored;
    }
    return deps.liveFunding(coin, fromMs, toMs);
  }

  async function stored(id: string, fromMs: number, toMs: number, agg: Agg): Promise<DailySeries> {
    if (!deps.hasDb()) return { t: [], v: [] };
    return toDaily(await deps.series(id, fromMs, toMs + DAY_MS - 1), agg);
  }

  return {
    id: "ht",
    name: "Hypertrade",
    notes:
      "Hypertrade Postgres (candles, funding, collector observations) with live Hyperliquid fallback for price and funding when no DB is configured. Stored series start when collection started.",
    metrics: () => METRICS,
    async fetch(key, asset, fromMs, toMs) {
      const coin = htCoin(asset);
      const global = GLOBAL_SERIES.get(key);
      let out: DailySeries;
      if (global) out = await stored(global, fromMs, toMs, "last");
      else if (ASSET_SERIES[key]) out = await stored(ASSET_SERIES[key](coin), fromMs, toMs, "last");
      else if (key === "price" || key === "volume" || key === "range") {
        const bars = await candles(coin, fromMs, toMs);
        const value = (b: Ohlcv) => (key === "price" ? b.c : key === "volume" ? b.v * b.c : b.c > 0 ? (b.h - b.l) / b.c : NaN);
        out = toDaily(
          bars.map((b) => ({ t: b.t, v: value(b) })),
          "last",
        );
      } else if (key === "funding" || key === "premium") {
        const rows = await funding(coin, fromMs, toMs + DAY_MS - 1);
        out = toDaily(
          rows.map((r) => ({ t: r.t, v: key === "funding" ? r.rate : r.premium })),
          key === "funding" ? "sum" : "mean",
        );
      } else throw new Error(`unknown ht metric: ${key}`);
      return clip(out, fromMs, toMs);
    },
  };
}

export const htProvider = createHtProvider();
