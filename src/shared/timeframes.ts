// Chart timeframes, shared by the candle API, the sync engine and the UI.
// Every value is a native Hyperliquid candleSnapshot interval, so no
// timeframe is ever resampled from a finer one while HL still has it.

export const TIMEFRAMES = ["1m", "5m", "15m", "1h", "4h", "1d", "1w", "1M"] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Nominal bar length. 1M is calendar months, so its value is an upper bound (31d). */
export const TF_MS: Record<Timeframe, number> = {
  "1m": MIN,
  "5m": 5 * MIN,
  "15m": 15 * MIN,
  "1h": HOUR,
  "4h": 4 * HOUR,
  "1d": DAY,
  "1w": 7 * DAY,
  "1M": 31 * DAY,
};

export function isTimeframe(s: unknown): s is Timeframe {
  return typeof s === "string" && (TIMEFRAMES as readonly string[]).includes(s);
}

/** HTF = daily and above. Drives which history sources are worth reaching for. */
export function isHtf(tf: Timeframe): boolean {
  return TF_MS[tf] >= DAY;
}

/**
 * Stored-history retention. Hyperliquid only serves the latest 5000 bars per
 * interval (3.5 days of 1m), so LTF history beyond that exists only because
 * the cron persisted it. The finest intervals are capped so the table stays
 * small; older 1m/5m bars are re-fetched from the external source on demand.
 */
export const TF_RETENTION_MS: Partial<Record<Timeframe, number>> = {
  "1m": 30 * DAY,
  "5m": 120 * DAY,
};

/** Bars per page for the chart API. */
export const DEFAULT_PAGE_BARS = 1500;
export const MAX_PAGE_BARS = 5000;
