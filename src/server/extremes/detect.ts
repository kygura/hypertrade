import type { ExtremeEvent, ExtremeKind, ExtremeWindow } from "../../shared/extremes.js";
import type { Side } from "../../shared/intel.js";
import { fundingAprPct, robustSigma } from "../../shared/signalMath.js";
import { ENDPOINT_TOLERANCE_MS, METRIC_RULES, robustLevelZ } from "../intel/windows.js";
import type { RingPoint } from "../platform/features.js";

// Extremes detector (src/shared/extremes.ts): rare, tape-first events in a coin's own 15-min history. Pure: points in,
// events out; reads only points with ts <= now. Three kinds, at most one event per kind per call (strongest window):
//   price_dislocation  log return over 4h / 24h / 72h in robust sigmas of the coin's own same-length returns over the
//                      lookback; a non-BTC coin also needs its BTC residual (return − beta × BTC return) extreme in the
//                      same direction, so a market-wide move does not fire every coin. side = against the move.
//   oi_flush           OI in contracts (oiUsd / mark, so a price move cannot fake it) down hard over 1h / 4h / 24h
//                      (percent and robust z) with a price move in the same window. Price down: longs flushed, side
//                      long; price up: shorts flushed, side short.
//   crowded_asymmetry  funding at an extreme of its lookback distribution (percentile and robust level z, and a
//                      minimum apr), OI contracts near the top of their lookback range, and price over 24h flat or
//                      against the crowd. side = against the crowd.
// z of a change = change / robust sigma of the same-length changes over the lookback (zero-centred: a month's drift is
// not a baseline), history windows ending before the current one opens. OI kinds read nothing when OI is absent
// (HL candles carry no OI history): no reading, no event.

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** History the detectors read: z baselines, beta, funding and OI distributions. */
export const EXTREME_LOOKBACK_MS = 30 * DAY;
/** A coin with less history than this (first point after now − this) is not evaluable and returns []. */
export const EXTREME_MIN_HISTORY_MS = 14 * DAY;
/** The coin whose return the residual leg removes. */
export const BTC_COIN = "BTC";

const WINDOW_MS: Record<ExtremeWindow, number> = { "1h": HOUR, "4h": 4 * HOUR, "24h": DAY, "72h": 3 * DAY };
const PRICE_WINDOWS = ["4h", "24h", "72h"] as const;
const OI_WINDOWS = ["1h", "4h", "24h"] as const;
type PriceWindow = (typeof PRICE_WINDOWS)[number];
type OiWindow = (typeof OI_WINDOWS)[number];
/** History windows are non-overlapping up to 4 h and spaced 4 h beyond: 30 d holds only 10 disjoint 72 h windows, too few for a MAD. */
const strideOf = (ms: number) => Math.min(ms, 4 * HOUR);
/** A z needs at least this many history windows (14 d of 4 h windows is 84). */
const MIN_SAMPLES = 40;
/** Beta to BTC from 4 h returns, clamped: a thin or odd history cannot make the residual leg meaningless. */
const BETA_RANGE = [0, 2] as const;

export type ExtremeThresholds = {
  price: {
    /** |own z| at least, per window: short windows have fatter tails, so one cut would fire almost only on 4 h. */
    z: Record<PriceWindow, number>;
    /** |BTC-residual z| at least, same sign as the move (non-BTC coins), per window. */
    zResid: Record<PriceWindow, number>;
    /** |return| at least, per window (fraction): a quiet coin's big z is not an extreme price. */
    minMove: Record<PriceWindow, number>;
  };
  oiFlush: {
    /** OI contracts change z at most −this, per window (as price: shorter windows have fatter tails). */
    z: Record<OiWindow, number>;
    /** OI contracts drop at least, per window (fraction). */
    minDrop: Record<OiWindow, number>;
    /** |price z| over the same window at least. */
    zPrice: number;
  };
  crowded: {
    /** Funding level robust z at least (sign of the crowd). */
    zFunding: number;
    /** Funding percentile at least (longs crowded) or at most 1 − this (shorts crowded). */
    pctile: number;
    /** |funding apr %| at least. */
    minAprPct: number;
    /** OI contracts percentile over the lookback at least. */
    oiPctile: number;
    /** 24 h price z in the crowd's direction at most (flat or against it). */
    maxFollowZ: number;
  };
};

/**
 * Calibrated on the candle replay (`bun run extremes replay`, top 30 HL perps, 15-min candles, 2026-10-05..11-14, 5.4
 * weeks) for frequency only, never for forward returns:
 *   price      robust z on 15-min data is fat-tailed (a 4σ cut fired 31 a week); these cuts give about 1.8 a week.
 *   oiFlush    no OI history on candles: set by analogy on the same sigma scale (1 h ≈ price's 4 h cut, 24 h ≈ its 72 h)
 *              plus hard drops; unvalidated until stored snapshots carry 14+ days.
 *   crowded    funding sits at HL's 11% apr default most of the time, so its MAD is tiny and z runs to tens: the
 *              percentile and the apr bar do the gating. Funding and price legs alone fired 4.6 a week on candles; the
 *              OI leg (95th pctile) is unmeasured and expected to cut that several-fold.
 */
export const DEFAULT_EXTREME_THRESHOLDS: ExtremeThresholds = {
  price: { z: { "4h": 11, "24h": 7.5, "72h": 6 }, zResid: { "4h": 9, "24h": 6, "72h": 5 }, minMove: { "4h": 0.12, "24h": 0.15, "72h": 0.25 } },
  oiFlush: { z: { "1h": 10, "4h": 8, "24h": 6 }, minDrop: { "1h": 0.08, "4h": 0.15, "24h": 0.25 }, zPrice: 3 },
  crowded: { zFunding: 5, pctile: 0.99, minAprPct: 75, oiPctile: 0.95, maxFollowZ: 0.5 },
};

export interface DetectInput {
  coin: string;
  points: RingPoint[];
  /** BTC points over the same span, null for BTC itself or when unavailable */
  btc: RingPoint[] | null;
  now: number;
}

type PriceReading = {
  window: PriceWindow;
  ret: number;
  z: number | null;
  btcRet: number | null;
  beta: number | null;
  resid: number | null;
  zResid: number | null;
  /** OI contracts change over the window (fraction), null without OI. */
  oiChg: number | null;
  fires: boolean;
};
type OiReading = {
  window: OiWindow;
  oiChg: number;
  z: number | null;
  ret: number | null;
  zPrice: number | null;
  fundingBefore: number | null;
  fundingAfter: number | null;
  fires: boolean;
};
type CrowdedReading = {
  funding: number;
  fundingAprPct: number;
  fundingPctile: number;
  fundingZ: number | null;
  oiPctile: number;
  ret24h: number | null;
  z24h: number | null;
  fires: boolean;
};
export type ExtremeReadings = {
  coin: string;
  now: number;
  /** False below EXTREME_MIN_HISTORY_MS of history or without a mark at now: every list below is empty. */
  evaluable: boolean;
  mark: number | null;
  funding: number | null;
  price: PriceReading[];
  oi: OiReading[];
  crowded: CrowdedReading | null;
};

type Get = (p: RingPoint) => number;
const markOf: Get = (p) => p.mark;
const fundingOf: Get = (p) => p.funding;
const contractsOf: Get = (p) => (p.oiUsd > 0 && p.mark > 0 ? p.oiUsd / p.mark : NaN);

/** Index of the first point with ts > t. */
function upper(points: RingPoint[], t: number): number {
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid]!.ts <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The value of the point nearest `t` within the Flow endpoint tolerance (intel/windows.ts valueAt), null when none or not finite. */
function at(points: RingPoint[], t: number, f: Get): number | null {
  const i = upper(points, t);
  let best: RingPoint | undefined;
  for (const p of [points[i - 1], points[i]]) if (p && (!best || Math.abs(p.ts - t) < Math.abs(best.ts - t))) best = p;
  if (!best || Math.abs(best.ts - t) > ENDPOINT_TOLERANCE_MS) return null;
  const v = f(best);
  return Number.isFinite(v) ? v : null;
}

function logChange(points: RingPoint[], f: Get, end: number, ms: number): number | null {
  const a = at(points, end - ms, f);
  const b = at(points, end, f);
  return a != null && b != null && a > 0 && b > 0 ? Math.log(b / a) : null;
}

/** Ends of the history windows of length `ms` before `now`: the first closes when the current one opens. */
function historyEnds(now: number, ms: number): number[] {
  const out: number[] = [];
  for (let end = now - ms; end - ms >= now - EXTREME_LOOKBACK_MS; end -= strideOf(ms)) out.push(end);
  return out;
}

/** Change over (now − ms, now] and its zero-centred robust z against the history windows; z null below MIN_SAMPLES. */
function changeZ(points: RingPoint[], f: Get, now: number, ms: number): { x: number | null; z: number | null } {
  const x = logChange(points, f, now, ms);
  if (x == null) return { x, z: null };
  const hist = historyEnds(now, ms).flatMap((e) => logChange(points, f, e, ms) ?? []);
  return { x, z: hist.length >= MIN_SAMPLES ? x / robustSigma(hist, METRIC_RULES.price.floor) : null };
}

/** OLS beta of 4 h coin returns on BTC's over the lookback, clamped to BETA_RANGE; null below MIN_SAMPLES pairs. */
function betaToBtc(points: RingPoint[], btc: RingPoint[], now: number): number | null {
  const xs: number[] = [];
  const ys: number[] = [];
  for (let end = now; end - 4 * HOUR >= now - EXTREME_LOOKBACK_MS; end -= 4 * HOUR) {
    const y = logChange(points, markOf, end, 4 * HOUR);
    const x = logChange(btc, markOf, end, 4 * HOUR);
    if (x != null && y != null) xs.push(x), ys.push(y);
  }
  if (xs.length < MIN_SAMPLES) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let cov = 0;
  let vx = 0;
  for (let i = 0; i < xs.length; i++) cov += (xs[i]! - mx) * (ys[i]! - my), vx += (xs[i]! - mx) ** 2;
  return vx > 0 ? Math.min(BETA_RANGE[1], Math.max(BETA_RANGE[0], cov / vx)) : null;
}

/** Hourly samples of `f` over the lookback ending at now, ascending (Point shape for intel/windows.ts). */
function hourly(points: RingPoint[], f: Get, now: number): Array<{ t: number; v: number }> {
  const out: Array<{ t: number; v: number }> = [];
  for (let t = now - EXTREME_LOOKBACK_MS + HOUR; t <= now; t += HOUR) {
    const v = at(points, t, f);
    if (v != null) out.push({ t, v });
  }
  return out;
}

const pctileOf = (xs: number[], v: number) => xs.filter((x) => x <= v).length / xs.length;
const exp1 = (x: number | null) => (x == null ? null : Math.expm1(x));

/** Every reading the three detectors take at `now`, with whether each passes its thresholds. Pure; reads ts <= now only. */
export function readExtremes(input: DetectInput, th: ExtremeThresholds = DEFAULT_EXTREME_THRESHOLDS): ExtremeReadings {
  const { coin, now } = input;
  const span = (pts: RingPoint[]) => pts.slice(upper(pts, now - EXTREME_LOOKBACK_MS - DAY), upper(pts, now));
  const points = span(input.points);
  const btc = input.btc ? span(input.btc) : null;
  const mark = at(points, now, markOf);
  const funding = at(points, now, fundingOf);
  const out: ExtremeReadings = { coin, now, evaluable: false, mark, funding, price: [], oi: [], crowded: null };
  if (!points.length || points[0]!.ts > now - EXTREME_MIN_HISTORY_MS || mark == null || !(mark > 0)) return out;
  out.evaluable = true;

  // price_dislocation
  const isBtc = coin === BTC_COIN;
  const beta = btc && !isBtc ? betaToBtc(points, btc, now) : null;
  for (const window of PRICE_WINDOWS) {
    const ms = WINDOW_MS[window];
    const own = changeZ(points, markOf, now, ms);
    if (own.x == null) continue;
    const btcRet = btc && !isBtc ? logChange(btc, markOf, now, ms) : null;
    let resid: number | null = null;
    let zResid: number | null = null;
    if (beta != null && btcRet != null) {
      resid = own.x - beta * btcRet;
      const hist = historyEnds(now, ms).flatMap((e) => {
        const y = logChange(points, markOf, e, ms);
        const x = logChange(btc!, markOf, e, ms);
        return y != null && x != null ? [y - beta * x] : [];
      });
      if (hist.length >= MIN_SAMPLES) zResid = resid / robustSigma(hist, METRIC_RULES.price.floor);
    }
    const p = th.price;
    const ret = Math.expm1(own.x);
    const residOk = isBtc || (zResid != null && Math.sign(zResid) === Math.sign(own.x) && Math.abs(zResid) >= p.zResid[window]);
    const fires = own.z != null && Math.abs(own.z) >= p.z[window] && Math.abs(ret) >= p.minMove[window] && residOk;
    out.price.push({ window, ret, z: own.z, btcRet: exp1(btcRet), beta, resid: exp1(resid), zResid, oiChg: exp1(logChange(points, contractsOf, now, ms)), fires });
  }

  // oi_flush
  for (const window of OI_WINDOWS) {
    const ms = WINDOW_MS[window];
    const oi = changeZ(points, contractsOf, now, ms);
    if (oi.x == null) continue;
    const px = changeZ(points, markOf, now, ms);
    const o = th.oiFlush;
    const oiChg = Math.expm1(oi.x);
    const fires = oi.z != null && oi.z <= -o.z[window] && oiChg <= -o.minDrop[window] && px.z != null && px.x !== 0 && Math.abs(px.z) >= o.zPrice;
    out.oi.push({ window, oiChg, z: oi.z, ret: exp1(px.x), zPrice: px.z, fundingBefore: at(points, now - ms, fundingOf), fundingAfter: funding, fires });
  }

  // crowded_asymmetry: needs OI at now, funding at now and their lookback distributions.
  const contracts = at(points, now, contractsOf);
  if (contracts != null && funding != null && funding !== 0) {
    const fh = hourly(points, fundingOf, now);
    const oh = hourly(points, contractsOf, now).map((p) => p.v);
    if (fh.length >= MIN_SAMPLES && oh.length >= MIN_SAMPLES) {
      const fundingPctile = pctileOf(fh.map((p) => p.v), funding);
      const fundingZ = robustLevelZ("funding", fh, now);
      const oiPctile = pctileOf(oh, contracts);
      const d = Math.sign(funding);
      const px = changeZ(points, markOf, now, DAY);
      const c = th.crowded;
      const extreme = d > 0 ? fundingPctile >= c.pctile && fundingZ != null && fundingZ >= c.zFunding : fundingPctile <= 1 - c.pctile && fundingZ != null && fundingZ <= -c.zFunding;
      const fires = extreme && Math.abs(fundingAprPct(funding)) >= c.minAprPct && oiPctile >= c.oiPctile && px.z != null && d * px.z <= c.maxFollowZ;
      out.crowded = { funding, fundingAprPct: fundingAprPct(funding), fundingPctile, fundingZ, oiPctile, ret24h: exp1(px.x), z24h: px.z, fires };
    }
  }
  return out;
}

// ---------------------------------------------------------------- events

const pct = (x: number, d = 1) => `${x < 0 ? "-" : "+"}${Math.abs(x * 100).toFixed(d)}%`;
const sig = (z: number) => `${z < 0 ? "-" : "+"}${Math.abs(z).toFixed(1)}σ`;
const apr = (hourly: number) => `${pct(fundingAprPct(hourly) / 100, 0)} apr`;
const ord = (q: number) => `${Math.min(100, Math.round(q * 100))}th pctile 30d`;

function event(kind: ExtremeKind, r: ExtremeReadings, side: Side, window: ExtremeWindow, severity: number, facts: Record<string, number | null>, line: string): ExtremeEvent {
  return { key: `${kind}|${r.coin}|${side}`, kind, coin: r.coin, side, ts: new Date(r.now).toISOString(), window, mark: r.mark!, severity, facts, line };
}

/** Events from readings: per kind, the passing reading furthest past its threshold (|z| / the window's cut). */
function eventsOf(r: ExtremeReadings, th: ExtremeThresholds = DEFAULT_EXTREME_THRESHOLDS): ExtremeEvent[] {
  const out: ExtremeEvent[] = [];
  const fundingFact = { funding: r.funding, fundingAprPct: r.funding == null ? null : fundingAprPct(r.funding) };

  const p = r.price.filter((x) => x.fires).sort((a, b) => Math.abs(b.z!) / th.price.z[b.window] - Math.abs(a.z!) / th.price.z[a.window])[0];
  if (p) {
    const parts = [`${sig(p.z!)} own`, ...(p.zResid != null ? [`${sig(p.zResid)} vs BTC`] : [])];
    const tail = [...(p.oiChg != null ? [`OI ${pct(p.oiChg, 0)} contracts`] : []), ...(r.funding != null ? [`funding ${apr(r.funding)}`] : [])];
    out.push(event("price_dislocation", r, p.ret < 0 ? "long" : "short", p.window, Math.abs(p.z!),
      { ret: p.ret, z: p.z, btcRet: p.btcRet, beta: p.beta, resid: p.resid, zResid: p.zResid, oiChg: p.oiChg, ...fundingFact },
      [`${r.coin} ${p.window} ${pct(p.ret)} (${parts.join(", ")})`, ...tail].join(", ")));
  }

  const o = r.oi.filter((x) => x.fires).sort((a, b) => a.z! / th.oiFlush.z[a.window] - b.z! / th.oiFlush.z[b.window])[0];
  if (o) {
    const fb = o.fundingBefore;
    const fa = o.fundingAfter;
    const fund = fb != null && fa != null ? `, funding ${apr(fb)} -> ${apr(fa)}` : "";
    out.push(event("oi_flush", r, o.ret! < 0 ? "long" : "short", o.window, Math.abs(o.z!),
      {
        oiChg: o.oiChg, oiZ: o.z, ret: o.ret, priceZ: o.zPrice, fundingBefore: fb, fundingAfter: fa,
        fundingBeforeAprPct: fb == null ? null : fundingAprPct(fb), fundingAfterAprPct: fa == null ? null : fundingAprPct(fa),
      },
      `${r.coin} ${o.window} OI ${pct(o.oiChg)} contracts (${sig(o.z!)}), price ${pct(o.ret!)} (${sig(o.zPrice!)})${fund}`));
  }

  const c = r.crowded;
  if (c?.fires) {
    out.push(event("crowded_asymmetry", r, c.funding > 0 ? "short" : "long", "24h", Math.abs(c.fundingZ!),
      { funding: c.funding, fundingAprPct: c.fundingAprPct, fundingPctile: c.fundingPctile, fundingZ: c.fundingZ, oiPctile: c.oiPctile, ret24h: c.ret24h, z24h: c.z24h },
      `${r.coin} funding ${apr(c.funding)} (${ord(c.fundingPctile)}, ${sig(c.fundingZ!)}), OI contracts ${ord(c.oiPctile)}, 24h ${pct(c.ret24h!)} (${sig(c.z24h!)})`));
  }
  return out;
}

/** The events at `now`: at most one per kind (its strongest window). [] when the coin is not evaluable. */
export function detectExtremes(input: DetectInput, thresholds: ExtremeThresholds = DEFAULT_EXTREME_THRESHOLDS): ExtremeEvent[] {
  return eventsOf(readExtremes(input, thresholds), thresholds);
}
