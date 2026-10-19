import type { FeatureVector, LiquidityTier } from "../../shared/platform.js";
import { classifyRegime } from "../desk/analytics.js";
import type { Point } from "../intel/normalize.js";
import { fin, median } from "../intel/util.js";
import { robustLevelZ, robustSigma, spanResult, valueAt } from "../intel/windows.js";
import { depthWithin, midOf, type Book } from "./costs.js";

// Per-asset feature set (docs/SPEC.md § Platform P0.9). Pure: history in, numbers out.
// z-scores reuse the Flow machinery (intel/windows.ts): non-overlapping window
// changes of the asset's own ring, median and MAD-based robust sigma. The ring
// is 24 h, so the lookback is 1 day with at least MIN_HIST window samples
// (fewer -> null). fundingZ24h / fundingPctile24h are computed on that same 24 h ring (feature keys are free-form). A feature that cannot be computed is null, never NaN.

export type RingPoint = { ts: number; mark: number; oiUsd: number; funding: number; dayNtlVlm: number };
export type FeatureExtras = {
  /** Tracked liquidation notional within ±2% of mark (positions table). */
  liqNearUsd?: number | null;
  book?: Book | null;
};

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const LOOKBACK = { days: 1, min: 12 };
const series = (ring: RingPoint[], f: (p: RingPoint) => number): Point[] => ring.map((p) => ({ t: p.ts, v: f(p) })).filter((p) => Number.isFinite(p.v));

/**
 * Realized vol per sqrt(minute) over (since, now]: sum(r²) / sum(Δt minutes) across consecutive points.
 * Gap-normalized, so the 5-/15-min persisted grid after a restart gives the same scale as 1-min ticks. Null below `minMin` minutes of returns.
 */
function rv(marks: Point[], since: number, minMin: number): number | null {
  let ss = 0;
  let dt = 0;
  for (let i = 1; i < marks.length; i++) {
    const a = marks[i - 1]!;
    const b = marks[i]!;
    if (b.t <= since || !(b.t > a.t) || !(a.v > 0) || !(b.v > 0)) continue;
    ss += Math.log(b.v / a.v) ** 2;
    dt += (b.t - a.t) / MIN;
  }
  return dt >= minMin && dt > 0 ? Math.sqrt(ss / dt) : null;
}

/** z of (r15 − r60/4) against the same statistic on the trailing 15-min grid. */
function accelZ(marks: Point[], now: number): number | null {
  const stat = (end: number) => {
    const [a15, a60, b] = [valueAt(marks, end - 15 * MIN), valueAt(marks, end - HOUR), valueAt(marks, end)];
    return a15 && a60 && b && a15 > 0 && a60 > 0 && b > 0 ? Math.log(b / a15) - Math.log(b / a60) / 4 : null;
  };
  const cur = stat(now);
  const hist: number[] = [];
  for (let end = now - 15 * MIN; end - HOUR >= now - DAY; end -= 15 * MIN) {
    const s = stat(end);
    if (s != null) hist.push(s);
  }
  if (cur == null || hist.length < LOOKBACK.min) return null;
  return (cur - median(hist)) / robustSigma(hist, 1e-4);
}

export function computeFeatures(history: RingPoint[], now: number, extras: FeatureExtras = {}): FeatureVector {
  const ring = history.filter((p) => p.ts <= now && p.ts >= now - 14 * DAY && Number.isFinite(p.ts) && p.mark > 0).sort((a, b) => a.ts - b.ts);
  const last = ring.at(-1);
  const marks = series(ring, (p) => p.mark);
  const oi = series(ring, (p) => p.oiUsd);
  const funding = series(ring, (p) => p.funding);
  const day = ring.filter((p) => p.ts >= now - DAY);

  const ret15 = spanResult("price", marks, now, 15 * MIN, LOOKBACK);
  const ret1h = spanResult("price", marks, now, HOUR, LOOKBACK);
  const oi1h = spanResult("oi_usd", oi, now, HOUR, LOOKBACK);
  // vol24h is HL's rolling 24 h notional; its 1 h log change is the proxy for "1 h volume vs the 24 h hourly mean".
  const vol1h = spanResult("vol24h", series(day, (p) => p.dayNtlVlm), now, HOUR, LOOKBACK);
  const fund24 = funding.filter((p) => p.t >= now - DAY);
  const fundingZ24h = robustLevelZ("funding", fund24, now);

  let fundingPctile24h: number | null = null;
  if (last && Number.isFinite(last.funding) && fund24.length >= 48) fundingPctile24h = fund24.filter((p) => p.v <= last.funding).length / fund24.length;

  const rv1h = rv(marks, now - HOUR, 30);
  const rv24h = rv(marks, now - DAY, 240);
  const sigma1h = rv24h == null ? null : rv24h * Math.sqrt(60);

  const fundingApr = last ? last.funding * 24 * 365 * 100 : null;
  const regime = ret1h.delta == null ? null : classifyRegime(ret1h.delta, oi1h.delta, fundingZ24h, fundingApr);

  const liq = fin(extras.liqNearUsd);
  const b = extras.book ?? null;
  const mid = b ? midOf(b) : null;
  const bid = b && mid != null ? Math.max(...b.bids.map((l) => l.px).filter(Number.isFinite)) : NaN;
  const ask = b && mid != null ? Math.min(...b.asks.map((l) => l.px).filter(Number.isFinite)) : NaN;

  return {
    features: {
      ret15mZ: fin(ret15.z),
      priceAccelZ: fin(accelZ(marks, now)),
      oiChg1hZ: fin(oi1h.z),
      fundingZ24h: fin(fundingZ24h),
      fundingPctile24h: fin(fundingPctile24h),
      volRatio1hZ: fin(vol1h.z),
      rvExpansion: rv1h != null && rv24h ? fin(rv1h / rv24h) : null,
      liqPressure: liq != null && last && last.oiUsd > 0 ? fin(liq / last.oiUsd) : null,
      spreadBps: mid != null ? fin(((ask - bid) / mid) * 1e4) : null,
      depthUsd: b && mid != null ? fin(depthWithin(b.bids, mid) + depthWithin(b.asks, mid)) : null,
    },
    inputs: {
      ts: now,
      mark: last?.mark ?? null,
      oiUsd: fin(last?.oiUsd),
      funding: fin(last?.funding),
      dayNtlVlm: fin(last?.dayNtlVlm),
      fundingApr: fin(fundingApr),
      ret15mPct: fin(ret15.delta),
      ret1hPct: fin(ret1h.delta),
      oiChg1hPct: fin(oi1h.delta),
      sigma1h: fin(sigma1h),
      liqNearUsd: liq,
      points: ring.length,
      /** classifyRegime on the 1 h price and OI change. null without 1 h of history. */
      regime,
    },
  };
}

/** Tier 1 = most liquid third of the universe by 24 h notional volume, tier 3 = thinnest. Junk volume counts as 0. */
export function liquidityTiers(universe: Array<{ coin: string; dayNtlVlm: number }>): Record<string, LiquidityTier> {
  const sorted = universe.map((u) => ({ coin: u.coin, v: u.dayNtlVlm > 0 && Number.isFinite(u.dayNtlVlm) ? u.dayNtlVlm : 0 })).sort((a, b) => b.v - a.v || (a.coin < b.coin ? -1 : 1));
  return Object.fromEntries(sorted.map((u, i) => [u.coin, (i * 3 < sorted.length ? 1 : i * 3 < 2 * sorted.length ? 2 : 3) as LiquidityTier]));
}
