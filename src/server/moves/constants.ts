import { CROWDED_FUNDING_Z } from "../intel/narratives.js";

// Moves constants (docs/SPEC.md § Moves). The window and minimum-n rules are the attribution contract; the
// crowding and checklist thresholds are invented STARTING thresholds, not fitted values, and are labelled so.

export const HOUR_MS = 3_600_000;

// ---------------------------------------------------------------- attribution
/** Estimation window: the bars ending at the attribution window's start (out of sample). */
export const EST_BARS = 168;
/** Bars of the estimation window where coin, BTC and ETH all have returns, at least. */
export const MIN_EST_BARS = 120;
/** The attribution window needs at least this share of its bars. */
export const MIN_WINDOW_SHARE = 0.75;
/** A sector basket return exists at an hour only with at least this many peers present (coin, BTC, ETH excluded). */
export const SECTOR_MIN_PEERS = 2;
/** Sector peers fetched at most for an inline single-coin detail. */
export const DETAIL_SECTOR_PEERS = 4;
/** Robust-σ floor of hourly log returns and residuals. */
export const SIGMA_FLOOR = 1e-4;

// ---------------------------------------------------------------- flow and news hours
/** An hourly OI sample is the last snapshot at or before the bar close within this. */
export const OI_SAMPLE_TOLERANCE_MS = 10 * 60_000;
/** Hourly OI changes on the estimation window a flow-hour z needs. */
export const FLOW_MIN_N = 48;
/** An hour whose OI-change robust z is at or below this is a flow hour (forced deleveraging, either side). */
export const FLOW_Z = -2;
/** An hour is a news hour when an event was first seen in [t − before, t + after). */
export const NEWS_BEFORE_MS = 2 * HOUR_MS;
export const NEWS_AFTER_MS = HOUR_MS;

// ---------------------------------------------------------------- positioning (starting thresholds)
/** Prior hourly funding values a funding z reads, and the least it needs. */
export const FUNDING_Z_LOOKBACK = 336;
export const FUNDING_Z_MIN_N = 168;
export const FUNDING_SIGMA_FLOOR = 1e-6;
/** OI 24h/72h ago: the snapshot nearest that time within this. */
export const OI_CHG_TOLERANCE_MS = 20 * 60_000;
export { CROWDED_FUNDING_Z };
export const CROWDED_FUNDING_APR_PCT = 25;
export const CROWDED_OI_BUILD_PCT = 10;
export const CROWDED_PREMIUM_BPS = 5;

/** Liquidation map grid, as the board (routes/platform.ts /liqmap/board): 25 bps buckets within ±20% of mark. */
export const LIQ_BUCKET_BPS = 25;
export const LIQ_RANGE = 0.2;

// ---------------------------------------------------------------- checklists (starting thresholds)
export const ENTER_NEWS_MIN = 2;
export const ENTER_NEWS_RATIO = 2;
export const ENTER_MENTIONS_CHG_PCT = 50;
export const ENTER_CROWD_MAX = 1;
export const ENTER_RESIDUAL_Z = 1.5;
export const FADE_CROWD_MIN = 3;
export const FADE_NEWS72H_MIN = 5;
export const FADE_NEWS_RATIO_MAX = 1;
export const FADE_LIQ_SIGMAS = 1;
export const FADE_MIN_COVERAGE = 0.25;
/** Floor of the prior-7d daily news mean in the news ratio. */
export const NEWS_RATIO_FLOOR = 0.5;

// ---------------------------------------------------------------- universe, caching, weight
/** Main-dex perps by 24h volume in the universe, before my markets and the majors are added. */
export const MOVES_TOP_VOLUME = 30;
/** Universe cap; coins past it are listed in `dropped`. */
export const MOVES_TOP = 40;
/** Hourly candles held per coin: 10 days. */
export const CANDLE_BARS = 240;
/** Trailing-60s HL weight of the moves fetches' own requests (their share of the guard's 1000). */
export const MOVES_HL_BUDGET = 400;
/** A run that loaded fewer than this share of its coins failed and is retried. */
export const MOVES_MIN_LOADED_SHARE = 0.5;
/** A run is memoised until the next hour close plus this. */
export const MOVES_TTL_SLACK_MS = 2 * 60_000;
export const MOVES_RETRY_MS = 15 * 60_000;
export const MOVES_WAIT_MS = 2_000;
/** Universe answers are cached this long (positioning, liquidation and attention are recomputed after it). */
export const MOVES_RESPONSE_CACHE_MS = 60_000;
/** Headlines in a detail answer. */
export const MOVES_HEADLINES = 5;
/** Events read for the attention layer (8 days back). */
export const MOVES_EVENT_LIMIT = 2_000;
