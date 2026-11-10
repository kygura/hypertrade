import { UNIVERSE_ASSET } from "../../shared/research.js";
import { RuleSchema, type Rule } from "../lab/types.js";

// Signal definitions (docs/RESEARCH.md "Signals v2" S1): a signal is a Lab Rule written as data. The same rule is
// evaluated live (scan.ts: in zone on the latest closed daily bar?) and historically (lab_event_study), through the
// same engine functions. Theses from docs/research/candidates-redesign.md § B.4, cut to what a Lab Rule can say: at
// most two conditions (`<` / `>=` on `metric|transform|window`), a daily trend regime, and stop/target levels.
// Thresholds are starting points for the event study, not claims. Only ht:* metrics every perp has; `ht:oi` is
// collector snapshots (stored history only), so the OI definitions are in zone only where OI is collected.

export interface SignalDefinition {
  id: string;
  name: string;
  /** One line, facts. */
  thesis: string;
  rule: Omit<Rule, "asset">;
  /** Platform setup kinds (src/server/platform/setups.ts) that share the thesis intraday. */
  intradayKinds: string[];
}

export const DefinitionRuleSchema = RuleSchema.omit({ asset: true });

export const DEFINITIONS: SignalDefinition[] = [
  {
    id: "funding_fade",
    name: "Funding fade",
    thesis: "Funding at a 90-day extreme while open interest sits at its 30-day high: longs crowded, short the unwind.",
    rule: {
      direction: "short",
      horizonDays: 7,
      conditions: [
        { feature: "ht:funding|z|90", op: ">=", threshold: 2 },
        // "OI at 30-day high" as a rank: at most one of the prior 29 days higher. |ret_3d| < 1 ATR is left out (a
        // Rule holds two conditions, and no feature scales a return by ATR).
        { feature: "ht:oi|pctile|30", op: ">=", threshold: 0.95 },
      ],
    },
    intradayKinds: ["crowded_long"],
  },
  {
    id: "negative_funding_build",
    name: "Negative funding build",
    thesis: "Funding at a 90-day low while open interest grows 10% in a week: shorts piling in, long the squeeze.",
    rule: {
      direction: "long",
      horizonDays: 7,
      conditions: [
        { feature: "ht:funding|z|90", op: "<", threshold: -1.5 },
        // ret_7d ≥ −1 ATR (price not collapsing) is left out: a third condition, and ATR-scaled.
        { feature: "ht:oi|roc|7", op: ">=", threshold: 0.1 },
      ],
    },
    intradayKinds: ["negative_funding_squeeze"],
  },
  {
    id: "washout_reclaim",
    name: "Washout",
    thesis: "Price down 8% and open interest down 10% over three days: a long flush, long the bounce.",
    rule: {
      direction: "long",
      horizonDays: 7,
      // The washout leg only: the reclaim trigger (4 h close back above the washout midpoint) is intraday, and
      // funding < 0 / liquidation z are left out (two conditions; no liquidation metric). A 1-day return needs
      // roc(1), below the transform's minimum window of 2, so the drop is over 3 days.
      conditions: [
        { feature: "ht:price|roc|3", op: "<", threshold: -0.08 },
        { feature: "ht:oi|roc|3", op: "<", threshold: -0.1 },
      ],
      // Invalidation at the washout low: the 2-bar low (a Level's minimum n) under the signal bar.
      stop: { ref: "low", n: 2 },
    },
    intradayKinds: ["deleveraging_washout"],
  },
  {
    id: "trend_pullback_long",
    name: "Trend pullback (long)",
    thesis: "Daily up-trend with the close within 2% of its 20-day mean: buy the pullback.",
    rule: {
      direction: "long",
      horizonDays: 10,
      // |sma20_dist| ≤ 0.5 ATR as two bounds on the distance to the 20-day mean in percent (ma_ratio), not in ATR;
      // the funding-not-crowded condition is left out (two conditions).
      conditions: [
        { feature: "ht:price|ma_ratio|20", op: ">=", threshold: -0.02 },
        { feature: "ht:price|ma_ratio|20", op: "<", threshold: 0.02 },
      ],
      regime: { trend: ["up"] },
    },
    intradayKinds: [],
  },
  {
    id: "trend_pullback_short",
    name: "Trend pullback (short)",
    thesis: "Daily down-trend with the close within 2% of its 20-day mean: sell the bounce.",
    rule: {
      direction: "short",
      horizonDays: 10,
      conditions: [
        { feature: "ht:price|ma_ratio|20", op: ">=", threshold: -0.02 },
        { feature: "ht:price|ma_ratio|20", op: "<", threshold: 0.02 },
      ],
      regime: { trend: ["down"] },
    },
    intradayKinds: [],
  },
  {
    id: "range_breakout",
    name: "Range breakout",
    thesis: "Close above every close of the prior 19 days on volume 50% above its 20-day mean: long the breakout.",
    rule: {
      direction: "long",
      horizonDays: 7,
      // breakout_20 reads closes, not highs (no rolling-max feature): pctile(20) is 1 only above all 19 prior closes.
      conditions: [
        { feature: "ht:price|pctile|20", op: ">=", threshold: 1 },
        { feature: "ht:volume|ma_ratio|20", op: ">=", threshold: 0.5 },
      ],
    },
    // The intraday setup goes either way by the move's sign; only its long side has this daily version.
    intradayKinds: ["vol_expansion_breakout"],
  },
];

/** The definition's rule on an asset (for a coin's own data, or UNIVERSE_ASSET for a universe study). */
export const definitionRule = (d: SignalDefinition, asset: string = UNIVERSE_ASSET): Rule => RuleSchema.parse({ ...d.rule, asset });

/** The daily definition of a platform setup kind, if one names it. */
export const definitionForKind = (kind: string, defs: readonly SignalDefinition[] = DEFINITIONS): SignalDefinition | undefined =>
  defs.find((d) => d.intradayKinds.includes(kind));
