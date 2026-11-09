import type { NoveltyEntry, Opportunity } from "../../shared/platform.js";
import type { RadarCall } from "../../shared/radar.js";
import type { ResearchSignal } from "../../shared/research.js";
import { ruleText } from "../lab/engine/rules.js";
import { RuleSchema, type CatalogueEntry, type Condition, type MarketPulse, type Rule } from "../lab/types.js";

// Live signals → ResearchSignal (docs/RESEARCH.md B2). Pure. A catalogue rule firing now carries its own rule;
// a novelty item maps through NOVELTY_TABLE; platform opportunities and radar calls have no Lab twin (rule null).
// `evidence` is attached later by the board from the study cache.

type Unstudied = Omit<ResearchSignal, "evidence">;

const fixed = (x: number, d: number) => `${x >= 0 ? "+" : ""}${x.toFixed(d)}`;
/** Float noise off a multiple of the step (0.15000000000000002), and -0 → 0. */
const clean = (x: number) => Math.round(x * 1e6) / 1e6 + 0;

/** Every catalogue rule that fires on the latest data (Market Pulse), with the rule from its catalogue entry. */
export function ruleSignals(pulse: MarketPulse, catalogue: CatalogueEntry[]): Unstudied[] {
  const byId = new Map(catalogue.map((e) => [e.id, e]));
  const at = Date.parse(pulse.asOf);
  return pulse.assets.flatMap((a) =>
    a.rules.flatMap((r): Unstudied[] => {
      const e = byId.get(r.id);
      if (!r.firing || !e) return [];
      return [{
        id: `rule:${e.rule.asset}:${e.id}`, source: "rule", coin: e.rule.asset, direction: e.rule.direction,
        headline: `catalogue rule "${e.name}" in zone · ${e.rule.direction} ${e.rule.horizonDays}d`, at,
        rule: e.rule, ruleText: ruleText(e.rule), href: `/lab/rules/${e.id}`,
      }];
    }),
  );
}

/** Lab z(n) of a value whose novelty z (against the n−1.. previous values, current excluded) is z: the Lab window includes the current value. */
export const zIncludingCurrent = (n: number) => (z: number) => (z * (n - 1)) / n / Math.sqrt((n - 2 + (z * z * (n - 1)) / n) / (n - 1));

export interface NoveltyMap {
  /** Lab feature id `${metric}|${transform}|${window}`. */
  feature: string;
  /** Novelty value → the Lab feature's value on the same bar (unit and window differences). */
  toLab: (x: number) => number;
  /** The threshold is the Lab value rounded toward zero to this step, so the rule is in zone on the bar it came from. */
  step: number;
  /** Signed features set the rule's direction; volume does not. */
  signed: boolean;
  label: (x: number) => string;
}

/**
 * Novelty feature → Lab feature (docs/RESEARCH.md B2). The novelty detector and the Lab compute these on slightly
 * different windows, so toLab converts first:
 * - funding_z90: z of the day's funding against the previous 90 days; Lab z(90) includes the day (ht:funding is the
 *   daily sum of hourly rates, the detector's the mean; a z is scale-free).
 * - ret(7): close / close 7 days back − 1, the same as Lab roc(7).
 * - vol_x: volume / mean of the previous 20 days; Lab ma_ratio(20) = (v − ma) / ma with the day in the mean, which is
 *   19(x − 1) / (19 + x) when the previous 19 days average like the previous 20.
 */
export const NOVELTY_TABLE: Record<string, NoveltyMap> = {
  funding_z90: { feature: "ht:funding|z|90", toLab: zIncludingCurrent(90), step: 0.5, signed: true, label: (x) => `funding z90 ${fixed(x, 1)}` },
  "ret(7)": { feature: "ht:price|roc|7", toLab: (x) => x, step: 0.05, signed: true, label: (x) => `7d ret ${fixed(x * 100, 0)}%` },
  vol_x: { feature: "ht:volume|ma_ratio|20", toLab: (x) => (19 * (x - 1)) / (19 + x), step: 0.5, signed: false, label: (x) => `volume ${x.toFixed(1)}x 20d mean` },
};
/** Hold of a novelty rule: the detector's longest lookback that maps (7 days). */
export const NOVELTY_HORIZON_DAYS = 7;

/**
 * One Lab condition from a novelty value: the sign picks the side, the threshold is rounded toward zero to the step
 * (strictly inside on the `<` side, so the value itself is in zone).
 */
export function noveltyCondition(m: NoveltyMap, value: number): Condition {
  const lab = m.toLab(value);
  const steps = Math.round((Math.abs(lab) / m.step) * 1e9) / 1e9;
  const k = lab >= 0 ? Math.floor(steps) : -(Math.ceil(steps) - 1);
  return { feature: m.feature, op: lab >= 0 ? ">=" : "<", threshold: clean(k * m.step) };
}

/**
 * The novelty item as a Lab rule: up to two mapped features (table order), direction fading the first signed one
 * (high funding or a 7-day rally → short, the reverse → long). null when nothing maps or only volume does (volume
 * alone has no side).
 */
export function noveltyRule(e: Pick<NoveltyEntry, "coin" | "features">): Rule | null {
  const mapped = Object.entries(NOVELTY_TABLE).flatMap(([id, m]) => {
    const f = e.features.find((x) => x.id === id);
    return f ? [{ m, value: f.value }] : [];
  }).slice(0, 2);
  const side = mapped.find((x) => x.m.signed);
  if (!side) return null;
  const r = RuleSchema.safeParse({
    asset: e.coin,
    direction: side.value > 0 ? "short" : "long",
    horizonDays: NOVELTY_HORIZON_DAYS,
    conditions: mapped.map((x) => noveltyCondition(x.m, x.value)),
  });
  return r.success ? r.data : null;
}

export function noveltySignal(e: NoveltyEntry): Unstudied {
  const rule = noveltyRule(e);
  const facts = e.features.map((f) => NOVELTY_TABLE[f.id]?.label(f.value) ?? `${f.id} ${f.value}`);
  return {
    id: `novelty:${e.coin}:${e.barDate}`, source: "novelty", coin: e.coin, direction: null,
    headline: `${e.kind === "new_extreme" ? "new extreme" : "joint extreme"} ${e.barDate}: ${facts.join(", ")}`,
    at: Date.parse(e.detectedAt), rule, ruleText: rule && ruleText(rule), href: null,
  };
}

/** Intraday scanner setups: no Lab twin. */
export function opportunitySignal(o: Opportunity): Unstudied {
  const edge = o.netEdgeBps == null ? "" : ` · net edge ${fixed(o.netEdgeBps, 0)} bps (${o.edgeBasis})`;
  return {
    id: `opportunity:${o.coin}:${o.id}`, source: "opportunity", coin: o.coin, direction: o.direction,
    headline: `${o.setupKind} · ${o.status} · score ${o.score.toFixed(2)} · tier ${o.liquidityTier}${edge}`,
    at: Date.parse(o.createdAt), rule: null, ruleText: null, href: `/feed?id=${o.id}`,
  };
}

/** A landed radar call: a dated catalyst thesis, no Lab twin. The headline carries the code-stamped numbers only. */
export function radarSignal(c: RadarCall): Unstudied {
  const graded = Object.entries(c.rel).map(([h, x]) => `+${h}d ${fixed(x, 1)}% vs BTC`);
  return {
    id: `radar:${c.market}:${c.id}`, source: "radar", coin: c.market, direction: c.direction,
    headline: [`${c.stance} ${c.direction} · ${c.kind}`, `mark ${c.mark}`, `kill ${c.kill_price}`, ...graded].join(" · "),
    at: Date.parse(c.at), rule: null, ruleText: null, href: null,
  };
}
