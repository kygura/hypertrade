// External candle sources for history Hyperliquid no longer (or never) had.
// HL only serves the latest 5000 bars per interval and nothing before a
// coin's listing, so older bars come from venues with long public history:
//
//   Binance spot (data-api.binance.vision — the keyless market-data mirror,
//   not geo-blocked like api.binance.com): <COIN>USDT, 2017+ for majors.
//   Bitstamp: <coin>usd, 2011+ for BTC. Only reached once Binance is exhausted.
//
// Both page backwards: "the `limit` bars whose open time is <= endTime".
// A different venue's price is a proxy, so candleSync checks every source
// against the bars it would sit under before trusting it (the seam check).
import type { Timeframe } from "../../shared/timeframes.js";

export type SourceId = "binance" | "bitstamp";

export interface ExtBar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

/** Result of one backward page. `unsupported`: the venue has no such market. */
export type ExtPage = { kind: "ok"; bars: ExtBar[] } | { kind: "unsupported" };

export interface ExternalSource {
  id: SourceId;
  pageSize: number;
  supports(tf: Timeframe): boolean;
  /** Up to `limit` bars with open time <= endTime, ascending. */
  fetchBefore(coin: string, tf: Timeframe, endTime: number, limit: number, fetchFn?: typeof fetch): Promise<ExtPage>;
}

const FETCH_TIMEOUT_MS = 20_000;

/**
 * HL lists some low-priced coins in thousands ("kPEPE" = 1000 PEPE). External
 * venues quote the base token, so prices scale up and volumes down.
 */
export function externalBase(coin: string): { base: string; scale: number } | null {
  if (coin.includes(":") || coin.startsWith("@")) return null; // builder-deployed dex / spot index
  const k = /^k([A-Z0-9]+)$/.exec(coin);
  if (k) return { base: k[1]!, scale: 1000 };
  if (!/^[A-Z0-9]+$/.test(coin)) return null;
  return { base: coin, scale: 1 };
}

const scaleBar = (b: ExtBar, scale: number): ExtBar =>
  scale === 1 ? b : { t: b.t, o: b.o * scale, h: b.h * scale, l: b.l * scale, c: b.c * scale, v: b.v / scale };

const finite = (...xs: number[]) => xs.every((x) => Number.isFinite(x));

// ─── Binance ───

const BINANCE_KLINES = "https://data-api.binance.vision/api/v3/klines";
// Every chart timeframe except the calendar ones: 1w/1M are resampled from
// stored daily bars instead, so their bucket phase matches Hyperliquid's.
const BINANCE_TFS: ReadonlySet<Timeframe> = new Set(["1m", "5m", "15m", "1h", "4h", "1d"]);

export function parseBinanceKlines(raw: unknown, scale: number): ExtBar[] {
  if (!Array.isArray(raw)) throw new Error("Binance klines: expected an array");
  const out: ExtBar[] = [];
  for (const row of raw) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const bar = { t: Number(row[0]), o: Number(row[1]), h: Number(row[2]), l: Number(row[3]), c: Number(row[4]), v: Number(row[5]) };
    if (!finite(bar.t, bar.o, bar.h, bar.l, bar.c, bar.v)) continue;
    out.push(scaleBar(bar, scale));
  }
  return out.sort((a, b) => a.t - b.t);
}

export const binance: ExternalSource = {
  id: "binance",
  pageSize: 1000,
  supports: (tf) => BINANCE_TFS.has(tf),
  async fetchBefore(coin, tf, endTime, limit, fetchFn = fetch) {
    const m = externalBase(coin);
    if (!m) return { kind: "unsupported" };
    const url = `${BINANCE_KLINES}?symbol=${m.base}USDT&interval=${tf}&endTime=${endTime}&limit=${Math.min(limit, 1000)}`;
    const res = await fetchFn(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (res.status === 400) {
      // -1121 "Invalid symbol": no USDT market. Anything else is our bug; surface it.
      const body = (await res.json().catch(() => null)) as { code?: number } | null;
      if (body?.code === -1121) return { kind: "unsupported" };
      throw new Error(`Binance HTTP 400 (${body?.code ?? "?"})`);
    }
    if (!res.ok) throw new Error(`Binance HTTP ${res.status}`);
    return { kind: "ok", bars: parseBinanceKlines(await res.json(), m.scale) };
  },
};

// ─── Bitstamp ───

const BITSTAMP_STEP_SEC: Partial<Record<Timeframe, number>> = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "1h": 3600,
  "4h": 14400,
  "1d": 86400,
};

export function parseBitstampOhlc(raw: unknown, scale: number): ExtBar[] {
  const ohlc = (raw as { data?: { ohlc?: unknown } } | null)?.data?.ohlc;
  if (!Array.isArray(ohlc)) throw new Error("Bitstamp ohlc: unexpected payload");
  const out: ExtBar[] = [];
  for (const r of ohlc as Record<string, string>[]) {
    // Number("") is 0, a real-looking price, so empty fields are rejected explicitly.
    if (!r || [r.timestamp, r.open, r.high, r.low, r.close, r.volume].some((x) => x == null || x === "")) continue;
    const bar = { t: Number(r.timestamp) * 1000, o: Number(r.open), h: Number(r.high), l: Number(r.low), c: Number(r.close), v: Number(r.volume) };
    if (!finite(bar.t, bar.o, bar.h, bar.l, bar.c, bar.v)) continue;
    out.push(scaleBar(bar, scale));
  }
  return out.sort((a, b) => a.t - b.t);
}

export const bitstamp: ExternalSource = {
  id: "bitstamp",
  pageSize: 1000,
  supports: (tf) => BITSTAMP_STEP_SEC[tf] != null,
  async fetchBefore(coin, tf, endTime, limit, fetchFn = fetch) {
    const m = externalBase(coin);
    const step = BITSTAMP_STEP_SEC[tf];
    if (!m || !step) return { kind: "unsupported" };
    const url = `https://www.bitstamp.net/api/v2/ohlc/${m.base.toLowerCase()}usd/?step=${step}&end=${Math.floor(endTime / 1000)}&limit=${Math.min(limit, 1000)}`;
    const res = await fetchFn(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (res.status === 404) return { kind: "unsupported" };
    if (!res.ok) throw new Error(`Bitstamp HTTP ${res.status}`);
    return { kind: "ok", bars: parseBitstampOhlc(await res.json(), m.scale) };
  },
};

/** Deeper sources later: each only reaches below the previous one's floor. */
export const EXTERNAL_SOURCES: readonly ExternalSource[] = [binance, bitstamp];
