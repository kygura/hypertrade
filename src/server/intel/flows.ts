import type { FixedWindow, FlowFlag, HeatmapMetric } from "../../shared/intel.js";
import { flowFlag, LOOKBACK, pickWindow, robustLevelZ, valueAt, type Series, type WindowResult } from "./windows.js";

// Flow detectors (docs/SPEC.md § Flow F0.4). Pure, deterministic. Each condition
// is true, false or unknown (a series missing or too short for its z):
//   any false   → quiet (no flag)
//   any unknown → degraded flag (outcome unknown, never a false negative)
//   all true    → flag
// Score = max |z| among the detector's conditions; liquidity_thinning uses
// 1 + (p10 − depth)/p10 × 4. Funding and OI are HL's (snapshots);
// liquidations and volumes come from the flow venue.
//   crowded_long/short         funding level |z| ≥ 2 (z and funding agree in sign),
//                              OI 24h z ≥ 1, price 24h |z| < 1
//   negative_funding_oi_build  funding < 0, OI 24h z ≥ 1, price 24h z ≥ −0.5
//   deleveraging               OI 6h Δ ≤ −INTEL_DELEV_OI_PCT %, liquidations 6h z ≥ 2
//   spot_led/perp_led          price 6h |z| ≥ 2, g = z6h(spot vol) − z6h(perp vol) ≥ 1 / ≤ −1;
//                              no spot series → skipped
//   liquidity_thinning         depth ±2% (bid + ask) below its 30-day p10 (≥ 48 samples)

/** INTEL_DELEV_OI_PCT default. */
export const DELEV_OI_PCT = 8;
const DAY_MS = 86_400_000;

export interface DetectorInput {
  asset: string;
  now: number;
  /** windows.seriesFromRows(snapshots, flow rows). */
  series: Series;
  /** windows.computeWindows(series, now). */
  windows: WindowResult[];
  /** INTEL_DELEV_OI_PCT; non-finite → DELEV_OI_PCT. */
  delevOiPct?: number;
}

type Cond = boolean | null;
const test = (x: number | null | undefined, f: (x: number) => boolean): Cond => (x == null ? null : f(x));

function decide(
  i: DetectorInput,
  name: string,
  window: FixedWindow,
  conds: Cond[],
  numbers: Record<string, number | null | undefined>,
  score: (fired: boolean) => number,
): FlowFlag | null {
  if (conds.includes(false)) return null;
  const degraded = conds.includes(null);
  const nums: Record<string, number> = {};
  for (const [k, v] of Object.entries(numbers)) if (v != null && Number.isFinite(v)) nums[k] = v;
  return flowFlag({ asset: i.asset, kind: "detector", name, window, numbers: nums, score: score(!degraded), degraded, now: i.now });
}

const maxAbs = (...zs: (number | null | undefined)[]) => Math.max(0, ...zs.flatMap((z) => (z == null ? [] : [Math.abs(z)])));

/** 10th percentile, linear between ranks. */
function p10(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const r = 0.1 * (s.length - 1);
  const lo = Math.floor(r);
  return s[lo]! + (s[Math.min(lo + 1, s.length - 1)]! - s[lo]!) * (r - lo);
}

export function detectFlows(i: DetectorInput): FlowFlag[] {
  const w = (m: HeatmapMetric, win: FixedWindow) => pickWindow(i.windows, m, win) ?? { delta: null, z: null };
  const funding = valueAt(i.series.funding ?? [], i.now);
  const fundingZ = robustLevelZ("funding", i.series.funding, i.now);
  const oi24 = w("oi_usd", "24h");
  const price24 = w("price", "24h");
  const oi6 = w("oi_usd", "6h");
  const price6 = w("price", "6h");
  const liq6 = w("liq_usd", "6h");
  const spot6 = w("spot_volume_usd", "6h");
  const perp6 = w("perp_volume_usd", "6h");
  const delevPct = Number.isFinite(i.delevOiPct) ? i.delevOiPct! : DELEV_OI_PCT;
  const flags: (FlowFlag | null)[] = [];

  const crowdedNumbers = { funding, funding_z: fundingZ, oi_z_24h: oi24.z, oi_pct_24h: oi24.delta, price_z_24h: price24.z, price_pct_24h: price24.delta };
  const crowdedScore = () => maxAbs(fundingZ, oi24.z, price24.z);
  const oiBuild = test(oi24.z, (z) => z >= 1);
  const priceFlat = test(price24.z, (z) => Math.abs(z) < 1);
  flags.push(
    decide(i, "crowded_long", "24h", [test(fundingZ, (z) => z >= 2), test(funding, (f) => f > 0), oiBuild, priceFlat], crowdedNumbers, crowdedScore),
    decide(i, "crowded_short", "24h", [test(fundingZ, (z) => z <= -2), test(funding, (f) => f < 0), oiBuild, priceFlat], crowdedNumbers, crowdedScore),
    decide(
      i, "negative_funding_oi_build", "24h",
      [test(funding, (f) => f < 0), oiBuild, test(price24.z, (z) => z >= -0.5)],
      { funding, oi_z_24h: oi24.z, oi_pct_24h: oi24.delta, price_z_24h: price24.z, price_pct_24h: price24.delta },
      () => maxAbs(oi24.z, price24.z),
    ),
    decide(
      i, "deleveraging", "6h",
      [test(oi6.delta, (d) => d <= -delevPct), test(liq6.z, (z) => z >= 2)],
      { oi_pct_6h: oi6.delta, oi_z_6h: oi6.z, liq_usd_6h: liq6.delta, liq_z_6h: liq6.z, threshold_pct: -delevPct },
      () => maxAbs(oi6.z, liq6.z),
    ),
  );

  if (i.series.spot_volume_usd?.length) {
    const gap = spot6.z == null || perp6.z == null ? null : spot6.z - perp6.z;
    const nums = { price_z_6h: price6.z, price_pct_6h: price6.delta, spot_z_6h: spot6.z, perp_z_6h: perp6.z, gap };
    const priceMove = test(price6.z, (z) => Math.abs(z) >= 2);
    flags.push(
      decide(i, "spot_led", "6h", [priceMove, test(gap, (g) => g >= 1)], nums, () => maxAbs(price6.z, gap)),
      decide(i, "perp_led", "6h", [priceMove, test(gap, (g) => g <= -1)], nums, () => maxAbs(price6.z, gap)),
    );
  }

  const depthPts = i.series.depth_2 ?? [];
  const depth = valueAt(depthPts, i.now);
  const hist = depthPts.filter((p) => p.t <= i.now && p.t >= i.now - LOOKBACK["1h"].days * DAY_MS).map((p) => p.v);
  const floor = hist.length >= LOOKBACK["1h"].min ? p10(hist) : null;
  flags.push(
    decide(
      i, "liquidity_thinning", "1h",
      [depth == null || floor == null ? null : depth < floor],
      { depth_2: depth, p10: floor },
      (fired) => (fired ? 1 + ((floor! - depth!) / floor!) * 4 : 0),
    ),
  );

  return flags.filter((f): f is FlowFlag => f != null);
}
