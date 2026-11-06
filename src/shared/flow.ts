import type { AssetCtx } from "./types.js";

// Market-flow reads shared by the server (desk analytics, platform features) and the UI.
// Pure; analytics.test.ts pins them through the re-exports in src/server/desk/analytics.ts.

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

/** Hours in a year: an hourly funding rate times APR is the annual rate. */
export const APR = 24 * 365;

export const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

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

export const REGIME_NOTE: Record<FlowRegime, string> = {
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
