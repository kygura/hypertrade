// Wire types for the chart API (GET /api/candles/:coin) and the perp stats
// API (GET /api/perp/:coin), shared by server and UI.
import type { PredictedFunding } from "./hl-client.js";
import type { Timeframe } from "./timeframes.js";

/** One chart bar. Times are epoch ms (bar open). */
export interface ChartBar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  /** Venue the bar came from: "hl", "binance" or "bitstamp". */
  src: string;
  /** Mean hourly funding rate over the bar (fraction), null before funding history. */
  f: number | null;
  /** Mean premium over the bar (fraction). */
  p: number | null;
  /** Open interest (USD) at the bar's close: the last snapshot inside it. */
  oi: number | null;
}

export interface CandlesResponse {
  coin: string;
  tf: Timeframe;
  bars: ChartBar[];
  /** Older bars exist (stored or fetchable): ask again with before = bars[0].t. */
  hasMore: boolean;
  /** Last sync error for this series, if the page may be short because of it. */
  error: string | null;
  funding: { from: number | null; complete: boolean };
  oi: { from: number | null };
}

export interface PerpStats {
  coin: string;
  fetchedAt: string;
  ctx: {
    markPx: number;
    oraclePx: number;
    midPx: number;
    premium: number;
    /** Current hourly funding rate (fraction). */
    funding: number;
    openInterest: number;
    openInterestUsd: number;
    dayNtlVlm: number;
    dayBaseVlm: number | null;
    prevDayPx: number;
    dayChange: number;
    maxLeverage: number | null;
    impactBidPx: number | null;
    impactAskPx: number | null;
    isDelisted: boolean;
  } | null;
  atOiCap: boolean;
  predicted: PredictedFunding[];
  /** Mean hourly funding rate over trailing windows (fraction), null without history. */
  fundingAvg: { h24: number | null; d7: number | null; d30: number | null };
  /** OI (USD) change over trailing windows (fraction), from stored snapshots. */
  oiChange: { h24: number | null; d7: number | null };
}

/** Hourly funding rate -> annualized (HL settles hourly). */
export const fundingApr = (hourly: number) => hourly * 24 * 365;
