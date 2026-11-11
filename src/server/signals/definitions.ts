import { UNIVERSE_ASSET } from "../../shared/research.js";
import { RuleSchema, type Rule } from "../lab/types.js";

// Signal definitions (docs/RESEARCH.md "Signals v2" S1): a signal is a Lab Rule written as data. The same rule is
// evaluated live (scan.ts: in zone on the latest closed daily bar?) and historically (lab_event_study), through the
// same engine functions. Theses from docs/research/candidates-redesign.md § B.4, cut to what a Lab Rule can say: up
// to four conditions (`<` / `>=` on `metric|transform|window`), a daily trend regime, and stop/target levels.
// Thresholds are starting points for the event study, not claims. Metrics every perp has: ht:* (Hyperliquid price,
// volume, funding) and okx:oi, the coin's OKX USDT-swap open interest. OKX OI stands in for market positioning
// because Hyperliquid publishes no OI history (ht:oi is the collector's own snapshots, weeks deep, too short to
// study); ht:oi can replace it once the collector has enough history. Price moves measured against a coin's own
// volatility use vchg(w): the w-day log change in w-day sigmas (sd of the 30 daily log changes × √w), so one
// threshold means the same on BTC and on a memecoin. B.4 states those moves in ATR(14); a w-day sigma is not an
// ATR, so the cut differs from B.4's (each rule's comment says so).

export interface SignalDefinition {
  id: string;
  name: string;
  /** One line, facts. */
  thesis: string;
  rule: Omit<Rule, "asset">;
  /**
   * Platform setup kinds (src/server/platform/setups.ts) that share the thesis intraday, on this definition's side:
   * a kind that goes either way is named by one definition per side.
   */
  intradayKinds: string[];
}

export const DEFINITIONS: SignalDefinition[] = [
  {
    id: "funding_fade",
    name: "Funding fade",
    thesis: "Funding at a 90-day extreme, open interest at its 30-day high and price within one 3-day sigma of where it was: longs crowded without a move, short the unwind.",
    rule: {
      direction: "short",
      horizonDays: 7,
      conditions: [
        { feature: "ht:funding|z|90", op: ">=", threshold: 2 },
        // "OI at 30-day high" as a rank: at most one of the prior 29 days higher.
        { feature: "okx:oi|pctile|30", op: ">=", threshold: 0.95 },
        // |ret_3d| < 1 ATR as |3-day move| < one 3-day sigma (vchg; B.4 says ATR(14)).
        { feature: "ht:price|vchg|3", op: ">=", threshold: -1 },
        { feature: "ht:price|vchg|3", op: "<", threshold: 1 },
      ],
    },
    intradayKinds: ["crowded_long"],
  },
  {
    id: "negative_funding_build",
    name: "Negative funding build",
    thesis: "Funding more than 1.5 sigma below its 90-day mean, OKX open interest up 10% in a week and price not down more than one 7-day sigma: shorts piling in, long the squeeze.",
    rule: {
      direction: "long",
      horizonDays: 7,
      conditions: [
        { feature: "ht:funding|z|90", op: "<", threshold: -1.5 },
        { feature: "okx:oi|roc|7", op: ">=", threshold: 0.1 },
        // ret_7d ≥ −1 ATR (price not collapsing) as the 7-day move ≥ −1 seven-day sigma (vchg; B.4 says ATR(14)).
        { feature: "ht:price|vchg|7", op: ">=", threshold: -1 },
      ],
    },
    intradayKinds: ["negative_funding_squeeze"],
  },
  {
    id: "washout_reclaim",
    name: "Washout",
    thesis: "Price down 8% and open interest down 10% over three days with funding negative on the day: a long flush, long the bounce.",
    rule: {
      direction: "long",
      horizonDays: 7,
      // The washout leg only: the reclaim trigger (4 h close back above the washout midpoint) is intraday, and the
      // liquidation z has no metric. A 1-day return needs roc(1), below the transform's minimum window of 2, so the
      // drop is over 3 days, in percent (B.4: ≤ −2 ATR or ≤ −5% on the day).
      conditions: [
        { feature: "ht:price|roc|3", op: "<", threshold: -0.08 },
        { feature: "okx:oi|roc|3", op: "<", threshold: -0.1 },
        // funding_1d < 0: the day's summed hourly funding.
        { feature: "ht:funding|raw|0", op: "<", threshold: 0 },
      ],
      // Invalidation at the washout low: the 2-bar low (a Level's minimum n) under the signal bar.
      stop: { ref: "low", n: 2 },
    },
    intradayKinds: ["deleveraging_washout"],
  },
  {
    id: "trend_pullback_long",
    name: "Trend at its 20-day mean (long)",
    thesis: "Daily up-trend, close within 2% of its 20-day mean (above or below it) and funding not at an extreme (|z90| < 1): long the trend at its mean.",
    rule: {
      direction: "long",
      horizonDays: 10,
      // |sma20_dist| ≤ 0.5 ATR as two bounds on the distance to the 20-day mean in percent (ma_ratio), not in ATR (no
      // feature scales a distance to a mean by volatility). The band is symmetric, so this tests "price at its mean in
      // a trend", not a pullback from above: a close up to 2% above the mean is in zone too. The id keeps the B.4 name.
      conditions: [
        { feature: "ht:price|ma_ratio|20", op: ">=", threshold: -0.02 },
        { feature: "ht:price|ma_ratio|20", op: "<", threshold: 0.02 },
        // Funding not crowded: |funding_z90| < 1, as B.4 writes it (both sides).
        { feature: "ht:funding|z|90", op: ">=", threshold: -1 },
        { feature: "ht:funding|z|90", op: "<", threshold: 1 },
      ],
      regime: { trend: ["up"] },
    },
    intradayKinds: [],
  },
  {
    id: "trend_pullback_short",
    name: "Trend at its 20-day mean (short)",
    thesis: "Daily down-trend, close within 2% of its 20-day mean (above or below it) and funding not at an extreme (|z90| < 1): short the trend at its mean.",
    rule: {
      direction: "short",
      horizonDays: 10,
      conditions: [
        { feature: "ht:price|ma_ratio|20", op: ">=", threshold: -0.02 },
        { feature: "ht:price|ma_ratio|20", op: "<", threshold: 0.02 },
        { feature: "ht:funding|z|90", op: ">=", threshold: -1 },
        { feature: "ht:funding|z|90", op: "<", threshold: 1 },
      ],
      regime: { trend: ["down"] },
    },
    intradayKinds: [],
  },
  {
    id: "range_breakout",
    name: "Range breakout",
    thesis: "Close above every close of the prior 19 days on volume at least 1.54× the prior 19 days' mean: long the breakout.",
    rule: {
      direction: "long",
      horizonDays: 7,
      // breakout_20 reads closes, not highs (no rolling-max feature): pctile(20) is 1 only above all 19 prior closes.
      // ma_ratio(20) ≥ 0.5 compares the day's volume with a 20-day mean that includes the day itself:
      // v ≥ 1.5 · (v + 19·m19) / 20  ⇔  v ≥ (28.5 / 18.5) · m19 ≈ 1.54 × the prior 19-day mean.
      conditions: [
        { feature: "ht:price|pctile|20", op: ">=", threshold: 1 },
        { feature: "ht:volume|ma_ratio|20", op: ">=", threshold: 0.5 },
      ],
    },
    // The intraday setup goes either way by the move's sign: its long side.
    intradayKinds: ["vol_expansion_breakout"],
  },
  {
    id: "range_breakdown",
    name: "Range breakdown",
    thesis: "Close below every close of the prior 19 days on volume at least 1.54× the prior 19 days' mean: short the breakdown.",
    rule: {
      direction: "short",
      horizonDays: 7,
      // The mirror of range_breakout, on closes. pctile ranks the close among the other closes in the window as
      // (below + ½·equal) / count, so it is 0 only below all of them; the smallest value above 0 is ½ / 19 ≈ 0.026
      // (½ / 9 at the fewest closes it accepts), so < 0.01 is exactly "below every prior close".
      conditions: [
        { feature: "ht:price|pctile|20", op: "<", threshold: 0.01 },
        { feature: "ht:volume|ma_ratio|20", op: ">=", threshold: 0.5 },
      ],
    },
    // The short side of the intraday vol_expansion_breakout.
    intradayKinds: ["vol_expansion_breakout"],
  },
];

/** The definition's rule on an asset (for a coin's own data, or UNIVERSE_ASSET for a universe study). */
export const definitionRule = (d: SignalDefinition, asset: string = UNIVERSE_ASSET): Rule => RuleSchema.parse({ ...d.rule, asset });

/** The daily definition of a platform setup kind on a side, if one names it there. */
export const definitionForKind = (kind: string, side: Rule["direction"], defs: readonly SignalDefinition[] = DEFINITIONS): SignalDefinition | undefined =>
  defs.find((d) => d.rule.direction === side && d.intradayKinds.includes(kind));
