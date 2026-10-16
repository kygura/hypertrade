import type { Side } from "../../shared/intel.js";
import type { FeatureVector, LiquidityTier } from "../../shared/platform.js";
import { classifyRegime } from "../desk/analytics.js";
import type { Point } from "../intel/normalize.js";
import { median } from "../intel/util.js";
import { robustLevelZ, robustSigma, spanResult, valueAt } from "../intel/windows.js";
import { depthWithin, midOf, type Book } from "./costs.js";

// Per-asset feature set (SPEC.md § Platform P0.9). Pure: history in, numbers out.
// z-scores reuse the Flow machinery (intel/windows.ts): non-overlapping window
// changes of the asset's own ring, median and MAD-based robust sigma. The ring
// is 24 h, so the lookback is 1 day with at least MIN_HIST window samples
// (fewer -> null). A feature that cannot be computed is null, never NaN.

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
/** Gap beyond which two adjacent ring points are not one 1-min return. */
const MAX_GAP_MS = 3 * MIN;

const fin = (n: number | null | undefined): number | null => (n != null && Number.isFinite(n) ? n : null);
const series = (ring: RingPoint[], f: (p: RingPoint) => number): Point[] => ring.map((p) => ({ t: p.ts, v: f(p) })).filter((p) => Number.isFinite(p.v));

/** RMS of 1-min log returns in (since, now], or null below `min` returns. */
function rv(marks: Point[], since: number, min: number): number | null {
  let ss = 0;
  let n = 0;
  for (let i = 1; i < marks.length; i++) {
    const a = marks[i - 1]!;
    const b = marks[i]!;
    if (b.t <= since || b.t - a.t > MAX_GAP_MS || !(a.v > 0) || !(b.v > 0)) continue;
    ss += Math.log(b.v / a.v) ** 2;
    n++;
  }
  return n >= min ? Math.sqrt(ss / n) : null;
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
  const fundingZ7d = robustLevelZ("funding", funding.filter((p) => p.t >= now - 7 * DAY), now);

  let fundingPctile14d: number | null = null;
  if (last && Number.isFinite(last.funding) && funding.length >= 48) fundingPctile14d = funding.filter((p) => p.v <= last.funding).length / funding.length;

  const rv1h = rv(marks, now - HOUR, 30);
  const rv24h = rv(marks, now - DAY, 240);
  const sigma1h = rv24h == null ? null : rv24h * Math.sqrt(60);

  const fundingApr = last ? last.funding * 24 * 365 * 100 : null;
  const regime = ret1h.delta == null ? null : classifyRegime(ret1h.delta, oi1h.delta, fundingZ7d, fundingApr);

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
      fundingZ7d: fin(fundingZ7d),
      fundingPctile14d: fin(fundingPctile14d),
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

// ─── Setups ───

export type Thresholds = {
  /** |fundingZ7d| a crowded setup needs. */
  fundingZ: number;
  /** oiChg1hZ build (or drop) needed. */
  oiZ: number;
  /** |ret15mZ| for a move. */
  retZ: number;
  rvExpansion: number;
  volZ: number;
  /** |ret15mZ| below this counts as price flat. */
  flatZ: number;
};
/** Thinner books move on less, so lower tiers need a stronger signal. */
export const DEFAULT_THRESHOLDS: Record<LiquidityTier, Thresholds> = {
  1: { fundingZ: 2, oiZ: 1, retZ: 2, rvExpansion: 1.8, volZ: 1.5, flatZ: 1 },
  2: { fundingZ: 2.25, oiZ: 1.25, retZ: 2.25, rvExpansion: 2, volZ: 1.75, flatZ: 1 },
  3: { fundingZ: 2.5, oiZ: 1.5, retZ: 2.5, rvExpansion: 2.25, volZ: 2, flatZ: 1 },
};

export type Setup = { setupKind: string; direction: Side; stopPx: number; targetPx: number; invalidationPx: number; tags: string[] };

/**
 * Stop and target in σ units, σ = mark × sigma1h (24 h realized 1-min vol scaled to one hour, the ring's ATR stand-in).
 * invalidationPx = stopPx: the level that kills the thesis is the stop.
 */
const LEVELS: Record<string, { stop: number; target: number }> = {
  crowded_long: { stop: 1.5, target: 2 },
  negative_funding_squeeze: { stop: 1.5, target: 3 },
  deleveraging_washout: { stop: 1, target: 1.5 },
  vol_expansion_breakout: { stop: 1, target: 2 },
};

const ge = (x: number | null | undefined, t: number) => x != null && x >= t;
const le = (x: number | null | undefined, t: number) => x != null && x <= t;

/**
 * Candidate setups (unknown feature = condition not met). Kinds:
 *  crowded_long              short  flows crowded_long: funding z hot and > 0, OI building, price flat
 *  negative_funding_squeeze  long   flows negative_funding_oi_build: funding < 0 and cold, OI building, price not falling
 *  deleveraging_washout      long   flows deleveraging: OI dropping hard on a dump with vol expanding (long flush -> bounce)
 *  vol_expansion_breakout    by sign of the move; no flows detector: vol expanding, move and acceleration agree, volume confirms
 */
export function setupsFor(fv: FeatureVector, tier: LiquidityTier, thresholds: Record<LiquidityTier, Thresholds> = DEFAULT_THRESHOLDS): Setup[] {
  const T = thresholds[tier];
  const f = fv.features;
  const mark = fin(fv.inputs.mark as number | null);
  const funding = fin(fv.inputs.funding as number | null);
  const sigma = fin(fv.inputs.sigma1h as number | null);
  if (mark == null || !(mark > 0) || sigma == null || !(sigma > 0)) return [];
  const ret = f.ret15mZ;
  const out: Array<{ kind: string; direction: Side; tags: string[] }> = [];

  if (ge(f.fundingZ7d, T.fundingZ) && (funding ?? 0) > 0 && ge(f.oiChg1hZ, T.oiZ) && ret != null && Math.abs(ret) < T.flatZ)
    out.push({ kind: "crowded_long", direction: "short", tags: ["crowded_long", "funding_hot", "oi_building"] });
  if (le(f.fundingZ7d, -T.fundingZ / 2) && (funding ?? 0) < 0 && ge(f.oiChg1hZ, T.oiZ) && ge(ret, -0.5))
    out.push({ kind: "negative_funding_squeeze", direction: "long", tags: ["negative_funding", "oi_building", "squeeze_fuel"] });
  if (le(f.oiChg1hZ, -T.oiZ) && le(ret, -T.retZ) && ge(f.rvExpansion, T.rvExpansion))
    out.push({ kind: "deleveraging_washout", direction: "long", tags: ["deleveraging", "long_flush", "vol_expansion"] });
  if (ge(f.rvExpansion, T.rvExpansion) && ret != null && Math.abs(ret) >= T.retZ && f.priceAccelZ != null && Math.sign(f.priceAccelZ) === Math.sign(ret) && ge(f.volRatio1hZ, T.volZ))
    out.push({ kind: "vol_expansion_breakout", direction: ret > 0 ? "long" : "short", tags: ["vol_expansion", "volume_confirm", ret > 0 ? "breakout_up" : "breakout_down"] });

  return out.flatMap((s) => {
    const { stop, target } = LEVELS[s.kind]!;
    const d = s.direction === "long" ? 1 : -1;
    const stopPx = mark - d * stop * sigma * mark;
    const targetPx = mark + d * target * sigma * mark;
    return stopPx > 0 && targetPx > 0 ? [{ setupKind: s.kind, direction: s.direction, stopPx, targetPx, invalidationPx: stopPx, tags: s.tags }] : [];
  });
}
