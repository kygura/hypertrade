import type { NarrativeStage } from "../../shared/intel.js";
import type { Attention, CrowdingCheck, LayerState, LiqProximity, Positioning } from "../../shared/moves.js";
import type { Cluster } from "../../shared/platform.js";
import { fundingAprPct, zRobust } from "../../shared/signalMath.js";
import {
  CROWDED_FUNDING_APR_PCT, CROWDED_FUNDING_Z, CROWDED_OI_BUILD_PCT, CROWDED_PREMIUM_BPS, FUNDING_SIGMA_FLOOR, FUNDING_Z_LOOKBACK, FUNDING_Z_MIN_N,
  HOUR_MS, NEWS_RATIO_FLOOR, OI_CHG_TOLERANCE_MS,
} from "./constants.js";

// Positioning, liquidation proximity and attention for a moves row (docs/SPEC.md § Moves). Pure.
// HL `funding` is the hourly rate (a fraction); `premium` a fraction of the oracle price.

const fin = (x: number | null | undefined): number | null => (x != null && Number.isFinite(x) ? x : null);

/** A point of a series sampled from the scanner's snapshots (ts ms). */
export interface Sample { ts: number; v: number }

/** The sample nearest `at` within `tol`, else null. */
export function sampleNear(samples: Sample[], at: number, tol = OI_CHG_TOLERANCE_MS): number | null {
  let best: Sample | null = null;
  for (const s of samples) if (Math.abs(s.ts - at) <= tol && (!best || Math.abs(s.ts - at) < Math.abs(best.ts - at))) best = s;
  return best?.v ?? null;
}

export interface PositioningInput {
  /** Live context: hourly funding (fraction), premium (fraction), OI in USD, 24h notional volume. */
  ctx: { funding: number; premium: number | null; oiUsd: number; dayNtlVlm: number };
  /** Prior hourly funding values, oldest first (the latest FUNDING_Z_LOOKBACK are read). */
  fundingHourly: number[];
  /** OI samples (ts, USD), any order; the 24h / 72h ago points are the nearest within 20 min. */
  oi: Sample[];
  /** 100 · ln(close now / close 72h ago), null without the candles. */
  priceChg72hPct: number | null;
  now: number;
}

const check = (key: CrowdingCheck["key"], side: CrowdingCheck["side"], value: number | null, threshold: number, met: boolean | null): CrowdingCheck => ({ key, side, value, threshold, met });

/**
 * Funding z, funding APR, OI changes and the crowding checks per side. Long side (short mirrored):
 *   funding_z ≥ CROWDED_FUNDING_Z · funding_apr ≥ +25% · oi_build: OI 72h ≥ +10% with price 72h > 0 (short: < 0) ·
 *   premium ≥ +5 bps. A check with a missing input is null (not evaluable); `of` counts the evaluable ones per side.
 */
export function positioning(p: PositioningInput): Positioning {
  const { ctx } = p;
  const prior = p.fundingHourly.filter(Number.isFinite).slice(-FUNDING_Z_LOOKBACK);
  const fundingZ = prior.length >= FUNDING_Z_MIN_N ? fin(zRobust(ctx.funding, prior, FUNDING_SIGMA_FLOOR)) : null;
  const fundingApr = fundingAprPct(ctx.funding);
  const ago = (h: number) => sampleNear(p.oi, p.now - h * HOUR_MS);
  const chg = (h: number) => {
    const then = ago(h);
    return then != null && then > 0 && ctx.oiUsd > 0 ? 100 * (ctx.oiUsd / then - 1) : null;
  };
  const oiChg24hPct = chg(24);
  const oiChg72hPct = chg(72);
  const premiumBps = ctx.premium == null || !Number.isFinite(ctx.premium) ? null : ctx.premium * 1e4;
  const px = p.priceChg72hPct;
  const checks: CrowdingCheck[] = [];
  for (const side of ["long", "short"] as const) {
    const s = side === "long" ? 1 : -1;
    const ge = (v: number | null, th: number) => (v == null ? null : s * v >= th);
    checks.push(
      check("funding_z", side, fundingZ, s * CROWDED_FUNDING_Z, ge(fundingZ, CROWDED_FUNDING_Z)),
      check("funding_apr", side, fundingApr, s * CROWDED_FUNDING_APR_PCT, ge(fundingApr, CROWDED_FUNDING_APR_PCT)),
      check("oi_build", side, oiChg72hPct, CROWDED_OI_BUILD_PCT, oiChg72hPct == null || px == null ? null : oiChg72hPct >= CROWDED_OI_BUILD_PCT && s * px > 0),
      check("premium", side, premiumBps, s * CROWDED_PREMIUM_BPS, ge(premiumBps, CROWDED_PREMIUM_BPS)),
    );
  }
  const met = (side: string) => checks.filter((c) => c.side === side && c.met === true).length;
  return {
    fundingHourly: ctx.funding,
    fundingAprPct: fundingApr,
    fundingZ,
    fundingN: prior.length,
    premiumBps,
    oiUsd: ctx.oiUsd,
    oiChg24hPct,
    oiChg72hPct,
    oiN: p.oi.length,
    oiToVolume: ctx.dayNtlVlm > 0 ? ctx.oiUsd / ctx.dayNtlVlm : null,
    checks,
    longMet: met("long"),
    shortMet: met("short"),
    of: checks.filter((c) => c.side === "long" && c.met !== null).length,
  };
}

/** Distance to the nearest liquidation clusters in 24h sigmas. `state` says whether the map exists at all. */
export function liqProximity(state: LayerState, clusters: { long: Cluster | null; short: Cluster | null } | null, coverageRatio: number | null, sigma24hPct: number | null): LiqProximity {
  const nearestLong = clusters?.long ?? null;
  const nearestShort = clusters?.short ?? null;
  const sig = (c: Cluster | null) => (c && sigma24hPct != null && sigma24hPct > 0 ? c.distancePct / sigma24hPct : null);
  return { state, nearestLong, nearestShort, sigma24hPct, longSigmas: sig(nearestLong), shortSigmas: sig(nearestShort), coverageRatio: fin(coverageRatio) };
}

export interface AttentionInput {
  state: LayerState;
  /** First-seen times (ms) of the news events naming the coin; null when no store. */
  news: number[] | null;
  /** Elfa's latest sample, if the collector has one. mentionsChg24h is a fraction. */
  social: { mentions24h: number; mentionsChg24h?: number; ts: Date } | null;
  sectorId: string | null;
  sectorStage: NarrativeStage | null;
  now: number;
}

/** News counts (24h, 72h, prior-7d daily mean and ratio), Elfa mentions and the sector stage. */
export function attention(a: AttentionInput): Attention {
  const DAY = 24 * HOUR_MS;
  const count = (from: number, to: number) => (a.news ? a.news.filter((t) => t >= from && t < to).length : null);
  const news24h = count(a.now - DAY, a.now + 1);
  const news72h = count(a.now - 3 * DAY, a.now + 1);
  const prior = count(a.now - 8 * DAY, a.now - DAY);
  const newsDailyMean7d = prior == null ? null : prior / 7;
  return {
    state: a.state,
    news24h,
    news72h,
    newsDailyMean7d,
    newsRatio: news24h == null || newsDailyMean7d == null ? null : news24h / Math.max(NEWS_RATIO_FLOOR, newsDailyMean7d),
    mentions24h: fin(a.social?.mentions24h),
    mentionsChg24hPct: a.social?.mentionsChg24h == null ? null : fin(100 * a.social.mentionsChg24h),
    mentionsAsOf: a.social ? a.social.ts.toISOString() : null,
    sectorId: a.sectorId,
    sectorStage: a.sectorStage,
  };
}
