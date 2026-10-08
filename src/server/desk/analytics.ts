import type { FundingPoint } from "../../shared/hl-client.js";
import type { AssetCtx, Candle } from "../../shared/types.js";

// Flow diagnostics: the deterministic half of "is this move a trap or real
// flow?". The agents interpret; these numbers are what they interpret. All
// functions are pure so the fixtures in analytics.test.ts pin them.
//
// The read rests on four public signals Hyperliquid exposes:
//   price vs open interest  — who is acting (new positions vs closing ones)
//   funding                 — what perp longs pay to stay in (crowding)
//   premium (mark − oracle) — perp leading spot (leverage) vs spot leading
//   volume on up vs down bars — a CVD proxy: is the move bought or drifting

export type FlowRegime =
  | "crowded_long_build"
  | "new_longs"
  | "short_covering"
  | "spot_led_rally"
  | "crowded_short_build"
  | "new_shorts"
  | "long_liquidation"
  | "spot_led_selloff"
  | "range";

export interface TrapComponent {
  name: string;
  points: number;
  max: number;
  note: string;
}

export interface RallyDiagnostics {
  coin: string;
  windowHours: number;
  direction: "up" | "down" | "flat";
  priceChangePct: number;
  /** Null when OI history does not cover the window. */
  oiChangePct: number | null;
  fundingAprNow: number | null;
  fundingAprWindow: number | null;
  /** Window funding vs the prior 30 days of hourly settlements. */
  fundingZ: number | null;
  premiumBpsWindow: number | null;
  premiumZ: number | null;
  /** Window volume / the equal window before it. */
  volumeRatio: number | null;
  /** Share of window volume on bars that closed in the move's direction. */
  withMoveVolumeShare: number | null;
  realizedVolAnn: number | null;
  /** How far the last close sits from the window's extreme, percent. */
  offExtremePct: number;
  regime: FlowRegime;
  /** 0–100: how much of the move looks like positioning that can unwind. */
  trapScore: number;
  label: "low trap risk" | "mixed" | "elevated trap risk" | "no move";
  components: TrapComponent[];
  notes: string[];
}

const HOUR = 3_600_000;
const APR = 24 * 365;

export function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
}

export function stdev(xs: number[]): number {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / xs.length);
}

/** z of `x` against `base`; null when the base is too thin or flat. */
export function zScore(x: number, base: number[]): number | null {
  if (base.length < 24) return null;
  const s = stdev(base);
  if (!Number.isFinite(s) || s === 0) return null;
  return (x - mean(base)) / s;
}

const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** Value of a series at or just before `t` (series sorted ascending). */
function valueAt(series: Array<{ t: number; v: number }>, t: number): number | null {
  let out: number | null = null;
  for (const p of series) {
    if (p.t > t) break;
    out = p.v;
  }
  return out;
}

export function classifyRegime(priceChangePct: number, oiChangePct: number | null, fundingZ: number | null, fundingApr: number | null): FlowRegime {
  const FLAT = 1.5;
  const OI_MOVE = 3;
  if (Math.abs(priceChangePct) < FLAT) return "range";
  const up = priceChangePct > 0;
  const hotLong = (fundingZ ?? 0) >= 1.5 || (fundingApr ?? 0) >= 30;
  const hotShort = (fundingZ ?? 0) <= -1.5 || (fundingApr ?? 0) <= -15;
  if (oiChangePct == null) return up ? (hotLong ? "crowded_long_build" : "spot_led_rally") : hotShort ? "crowded_short_build" : "spot_led_selloff";
  if (up) {
    if (oiChangePct >= OI_MOVE) return hotLong ? "crowded_long_build" : "new_longs";
    if (oiChangePct <= -OI_MOVE) return "short_covering";
    return "spot_led_rally";
  }
  if (oiChangePct >= OI_MOVE) return hotShort ? "crowded_short_build" : "new_shorts";
  if (oiChangePct <= -OI_MOVE) return "long_liquidation";
  return "spot_led_selloff";
}

const REGIME_NOTE: Record<FlowRegime, string> = {
  crowded_long_build: "price up on rising OI with hot funding: longs are paying up to chase; fragile if spot does not follow",
  new_longs: "price up on rising OI with moderate funding: fresh positioning, not yet crowded",
  short_covering: "price up while OI falls: shorts closing, not new demand; these moves fade once covering ends",
  spot_led_rally: "price up without an OI build: spot or position-neutral buying carried it",
  crowded_short_build: "price down on rising OI with negative funding: shorts pressing; squeeze fuel if price holds",
  new_shorts: "price down on rising OI: fresh shorts",
  long_liquidation: "price down while OI falls: longs being flushed; often near exhaustion once OI stops falling",
  spot_led_selloff: "price down without an OI change: spot supply",
  range: "no directional move in the window",
};

export interface DiagnosticsInput {
  coin: string;
  windowHours: number;
  /** 1h candles covering at least 2× the window, ascending. */
  candles: Candle[];
  /** Hourly funding settlements covering ~30 days, ascending. */
  funding: FundingPoint[];
  /** OI (USD) snapshots, ascending; any cadence. */
  oi: Array<{ t: number; v: number }>;
  now: number;
  ctx?: Pick<AssetCtx, "funding" | "premium" | "markPx">;
}

export function rallyDiagnostics(input: DiagnosticsInput): RallyDiagnostics {
  const { coin, windowHours, now } = input;
  const start = now - windowHours * HOUR;
  const prevStart = start - windowHours * HOUR;
  const bars = input.candles.filter((c) => c.t < now);
  const win = bars.filter((c) => c.t >= start);
  const prev = bars.filter((c) => c.t >= prevStart && c.t < start);
  if (win.length < 2) throw new Error(`not enough 1h candles for ${coin} over ${windowHours}h`);

  const openPx = win[0]!.o;
  const lastPx = input.ctx?.markPx ?? win[win.length - 1]!.c;
  const priceChangePct = ((lastPx - openPx) / openPx) * 100;
  const direction: RallyDiagnostics["direction"] = Math.abs(priceChangePct) < 1.5 ? "flat" : priceChangePct > 0 ? "up" : "down";
  const dir = direction === "down" ? -1 : 1;

  // Open interest over the window, from snapshots. Requires a point within
  // 2h of the window start so a short history does not pass for a flat one.
  let oiChangePct: number | null = null;
  const oiStart = valueAt(input.oi, start);
  const firstOi = input.oi[0];
  const oiNow = input.oi.length ? input.oi[input.oi.length - 1]!.v : null;
  if (oiStart != null && oiNow != null && firstOi && firstOi.t <= start + 2 * HOUR && oiStart > 0) {
    oiChangePct = ((oiNow - oiStart) / oiStart) * 100;
  }

  // Funding: window mean vs the hourly distribution before the window.
  const fWin = input.funding.filter((f) => f.t >= start);
  const fBase = input.funding.filter((f) => f.t < start && f.t >= start - 30 * 24 * HOUR);
  const fundingAprNow = input.ctx ? input.ctx.funding * APR * 100 : fWin.length ? fWin[fWin.length - 1]!.rate * APR * 100 : null;
  const fWinMean = fWin.length ? mean(fWin.map((f) => f.rate)) : null;
  const fundingAprWindow = fWinMean == null ? null : fWinMean * APR * 100;
  const fundingZ = fWinMean == null ? null : zScore(fWinMean, fBase.map((f) => f.rate));
  const pWinMean = fWin.length ? mean(fWin.map((f) => f.premium)) : null;
  const premiumBpsWindow = pWinMean == null ? null : pWinMean * 1e4;
  const premiumZ = pWinMean == null ? null : zScore(pWinMean, fBase.map((f) => f.premium));

  const winVol = win.reduce((a, c) => a + c.v * c.c, 0);
  const prevVol = prev.reduce((a, c) => a + c.v * c.c, 0);
  const volumeRatio = prev.length >= windowHours * 0.8 && prevVol > 0 ? winVol / prevVol : null;
  const withMove = win.filter((c) => (dir > 0 ? c.c >= c.o : c.c <= c.o)).reduce((a, c) => a + c.v * c.c, 0);
  const withMoveVolumeShare = winVol > 0 ? withMove / winVol : null;

  const rets = win.slice(1).map((c, i) => Math.log(c.c / win[i]!.c));
  const realizedVolAnn = rets.length >= 6 ? stdev(rets) * Math.sqrt(APR) * 100 : null;

  const hi = Math.max(...win.map((c) => c.h));
  const lo = Math.min(...win.map((c) => c.l));
  const offExtremePct = dir > 0 ? ((hi - lastPx) / hi) * 100 : ((lastPx - lo) / lo) * 100;

  const regime = classifyRegime(priceChangePct, oiChangePct, fundingZ, fundingAprWindow);

  // Trap score: each component scores how much the move leans on positioning
  // that can unwind, measured in the move's own direction.
  const components: TrapComponent[] = [];
  const add = (name: string, points: number, max: number, note: string) => components.push({ name, points: round(clamp(points, 0, max), 1), max, note });

  if (direction !== "flat") {
    const fz = fundingZ == null ? null : dir * fundingZ;
    add(
      "funding heat",
      fz == null ? (dir * (fundingAprWindow ?? 0) >= 30 ? 15 : 0) : (fz / 3) * 25,
      25,
      fundingZ == null ? `window funding ${fmt(fundingAprWindow)}% APR (no 30d base)` : `window funding z ${round(fundingZ)} vs 30d, ${fmt(fundingAprWindow)}% APR`,
    );
    const pz = premiumZ == null ? null : dir * premiumZ;
    add(
      "perp premium",
      pz == null ? 0 : (pz / 3) * 15,
      15,
      premiumZ == null ? "premium history thin" : `perp premium ${fmt(premiumBpsWindow)} bps, z ${round(premiumZ)}: ${dir * premiumZ > 1 ? "perps leading spot" : "spot keeping pace"}`,
    );
    const oiPts =
      regime === "short_covering" || regime === "long_liquidation"
        ? 20
        : regime === "crowded_long_build" || regime === "crowded_short_build"
          ? 15
          : regime === "new_longs" || regime === "new_shorts"
            ? 7
            : 0;
    add("OI vs price", oiPts, 20, oiChangePct == null ? "no OI history for the window" : `OI ${fmt(oiChangePct)}% vs price ${fmt(priceChangePct)}%: ${REGIME_NOTE[regime]}`);
    add(
      "volume trend",
      volumeRatio == null ? 0 : volumeRatio < 1 ? ((1 - volumeRatio) / 0.5) * 15 : 0,
      15,
      volumeRatio == null ? "no prior window to compare volume" : `volume ${fmt(volumeRatio)}× the prior window${volumeRatio < 0.8 ? ": the move is thinning" : ""}`,
    );
    add(
      "bar participation",
      withMoveVolumeShare == null ? 0 : ((0.6 - withMoveVolumeShare) / 0.2) * 15,
      15,
      withMoveVolumeShare == null ? "no volume" : `${fmt(withMoveVolumeShare * 100)}% of volume on bars closing with the move`,
    );
    const vol = realizedVolAnn ?? 50;
    const sigmaMove = Math.abs(priceChangePct) / (vol / Math.sqrt(APR / windowHours));
    add("extension", ((sigmaMove - 1.5) / 1.5) * 10, 10, `move is ${fmt(sigmaMove)}σ of its own realized vol over the window`);
  }
  const trapScore = round(components.reduce((a, c) => a + c.points, 0), 0);
  const label: RallyDiagnostics["label"] = direction === "flat" ? "no move" : trapScore >= 55 ? "elevated trap risk" : trapScore >= 30 ? "mixed" : "low trap risk";

  const notes = [REGIME_NOTE[regime]];
  if (oiChangePct == null) notes.push("OI change unknown: the regime falls back to funding alone, read it with less weight");
  if (offExtremePct > 3) notes.push(`already ${fmt(offExtremePct)}% off the window extreme`);

  return {
    coin,
    windowHours,
    direction,
    priceChangePct: round(priceChangePct),
    oiChangePct: oiChangePct == null ? null : round(oiChangePct),
    fundingAprNow: fundingAprNow == null ? null : round(fundingAprNow),
    fundingAprWindow: fundingAprWindow == null ? null : round(fundingAprWindow),
    fundingZ: fundingZ == null ? null : round(fundingZ),
    premiumBpsWindow: premiumBpsWindow == null ? null : round(premiumBpsWindow),
    premiumZ: premiumZ == null ? null : round(premiumZ),
    volumeRatio: volumeRatio == null ? null : round(volumeRatio),
    withMoveVolumeShare: withMoveVolumeShare == null ? null : round(withMoveVolumeShare, 3),
    realizedVolAnn: realizedVolAnn == null ? null : round(realizedVolAnn, 1),
    offExtremePct: round(offExtremePct),
    regime,
    trapScore,
    label,
    components,
    notes,
  };
}

function fmt(x: number | null | undefined): string {
  return x == null || !Number.isFinite(x) ? "n/a" : String(round(x));
}

export interface Breadth {
  sample: number;
  advancingPct: number;
  medianDayChangePct: number;
  btcDayChangePct: number | null;
  /** BTC's day change minus the median alt's: positive = BTC-led. */
  btcLeadPct: number | null;
  oiWeightedFundingApr: number;
  hotFunding: Array<{ coin: string; fundingApr: number }>;
  coldFunding: Array<{ coin: string; fundingApr: number }>;
}

/** Breadth across the top `n` perps by open interest. */
export function marketBreadth(ctxs: AssetCtx[], n = 50): Breadth {
  const live = ctxs.filter((c) => !c.isDelisted && c.markPx > 0);
  const top = [...live].sort((a, b) => b.openInterest * b.markPx - a.openInterest * a.markPx).slice(0, n);
  const changes = top.map((c) => c.dayChange * 100).sort((a, b) => a - b);
  const median = changes.length ? changes[Math.floor(changes.length / 2)]! : 0;
  const btc = top.find((c) => c.name === "BTC");
  const oiTotal = top.reduce((a, c) => a + c.openInterest * c.markPx, 0);
  const wFunding = oiTotal > 0 ? top.reduce((a, c) => a + c.funding * c.openInterest * c.markPx, 0) / oiTotal : 0;
  const byFunding = [...top].sort((a, b) => b.funding - a.funding);
  const fApr = (c: AssetCtx) => ({ coin: c.name, fundingApr: round(c.funding * APR * 100) });
  return {
    sample: top.length,
    advancingPct: top.length ? round((top.filter((c) => c.dayChange > 0).length / top.length) * 100, 1) : 0,
    medianDayChangePct: round(median),
    btcDayChangePct: btc ? round(btc.dayChange * 100) : null,
    btcLeadPct: btc ? round(btc.dayChange * 100 - median) : null,
    oiWeightedFundingApr: round(wFunding * APR * 100),
    hotFunding: byFunding.slice(0, 5).map(fApr),
    coldFunding: byFunding.slice(-5).reverse().map(fApr),
  };
}
