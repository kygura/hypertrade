import type { LedgerStats, NoveltyEntry, Opportunity } from "../../shared/platform.js";
import { RADAR_HORIZONS, type RadarCall } from "../../shared/radar.js";
import type { LedgerEvidence, RadarScoreRow, ResearchSignal, ScorecardEvidence } from "../../shared/research.js";
import { parseFeatureId } from "../lab/engine/features.js";
import { fmtNum, ruleText } from "../lab/engine/rules.js";
import { RuleSchema, type CatalogueEntry, type Condition, type MarketPulse, type Rule } from "../lab/types.js";
import { LEDGER_HORIZON } from "../platform/stats.js";
import { definitionForKind, definitionRule } from "../signals/definitions.js";
import type { DefinitionHit } from "../signals/scan.js";

// Live signals → ResearchSignal (docs/RESEARCH.md B2, Signals v2 S3). Pure. A catalogue rule firing now carries its
// own rule; a novelty item maps through NOVELTY_TABLE; a signal definition in zone carries its own rule (universe
// scope); an opportunity carries its ledger record as evidence and the daily definition of its setup kind as its
// rule; a radar call carries its scorecard row and no rule (graded forward, not replayed). Study evidence (and an
// opportunity's `dailyStudy`) is attached later by the board from the study cache.

type Unstudied = Omit<ResearchSignal, "dailyStudy">;

const fixed = (x: number, d: number) => `${x >= 0 ? "+" : ""}${x.toFixed(d)}`;
/** Float noise off a multiple of the step (0.15000000000000002), and -0 → 0. */
const clean = (x: number) => Math.round(x * 1e6) / 1e6 + 0;

/** Catalogue entries of every rule that fires on the latest data (Market Pulse). */
export function firingEntries(pulse: MarketPulse, catalogue: CatalogueEntry[]): CatalogueEntry[] {
  const byId = new Map(catalogue.map((e) => [e.id, e]));
  return pulse.assets.flatMap((a) => a.rules.flatMap((r) => (r.firing && byId.has(r.id) ? [byId.get(r.id)!] : [])));
}

/** A catalogue rule firing now (at = the pulse's asOf): it carries its own rule, studied on its own asset. */
export function ruleSignal(e: CatalogueEntry, at: number): Unstudied {
  return {
    id: `rule:${e.rule.asset}:${e.id}`, source: "rule", coin: e.rule.asset, direction: e.rule.direction,
    headline: `catalogue rule "${e.name}" in zone · ${e.rule.direction} ${e.rule.horizonDays}d`, at,
    rule: e.rule, tested: e.rule.direction, scope: "coin", ruleText: ruleText(e.rule), href: `/lab/rules/${e.id}`,
    evidence: null, definitionId: null,
  };
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

/**
 * A novelty item: no side of its own (direction null). Its rule is studied as a fade of the extreme, one tested side
 * (one trial), stated as a hypothesis in `tested` and `ruleText`, never as a call. Studied over the Lab's default
 * universe: the rule reads ht:* metrics only, and one coin rarely has the 30 event-weeks a verdict needs.
 */
export function noveltySignal(e: NoveltyEntry): Unstudied {
  const rule = noveltyRule(e);
  const facts = e.features.map((f) => NOVELTY_TABLE[f.id]?.label(f.value) ?? `${f.id} ${f.value}`);
  return {
    id: `novelty:${e.coin}:${e.barDate}`, source: "novelty", coin: e.coin, direction: null,
    headline: `${e.kind === "new_extreme" ? "new extreme" : "joint extreme"} ${e.barDate}: ${facts.join(", ")}`,
    at: Date.parse(e.detectedAt), rule, tested: rule?.direction ?? null, scope: rule ? "universe" : "coin",
    ruleText: rule && `tested as fade: ${rule.direction} when ${ruleText(rule)}`, href: null,
    evidence: null, definitionId: null,
  };
}

/** "funding z(90) 2.41": a condition's feature and its value on the bar. */
function featureFact(feature: string, value: number | null): string {
  const s = parseFeatureId(feature);
  const name = `${s.metric.replace(/^ht:/, "")}${s.transform === "raw" ? "" : ` ${s.transform}(${s.window})`}`;
  return `${name} ${value == null ? "n/a" : fmtNum(value)}`;
}

/**
 * A signal definition in zone on the latest closed bar (scan.ts). Studied over the Lab's default universe under one
 * placeholder asset (UNIVERSE_ASSET), so every coin in zone shares one study. Headline: the observed values as facts.
 * at = the bar's close.
 */
export function definitionSignal(h: DefinitionHit): Unstudied {
  const d = h.definition;
  const rule = definitionRule(d);
  const facts = d.rule.conditions.map((c) => featureFact(c.feature, h.values[c.feature] ?? null));
  if (d.rule.regime) facts.push(`trend ${d.rule.regime.trend.join("/")}`);
  return {
    id: `definition:${h.coin}:${d.id}`, source: "definition", coin: h.coin, direction: rule.direction,
    headline: `${d.name} in zone ${h.date}: ${[...new Set(facts)].join(", ")}`,
    at: Date.parse(`${h.date}T00:00:00Z`) + 86_400_000,
    rule, tested: rule.direction, scope: "universe", ruleText: ruleText(rule), href: null,
    evidence: null, definitionId: d.id,
  };
}

/** An opportunity's setup kind in the ledger (setupLedgerStats records, platform/stats.ts); an empty record when the kind has none. */
export function ledgerEvidence(setupKind: string, stats: readonly LedgerStats[]): LedgerEvidence {
  const g = stats.find((s) => s.setupKind === setupKind && s.horizon === LEDGER_HORIZON && s.regime == null && s.tier == null);
  return {
    kind: "ledger", setupKind, horizon: LEDGER_HORIZON,
    n: g?.n ?? 0, clusters: g?.clusters ?? 0, meanNet: g?.meanNet ?? null, ci95: g?.ci95 ?? null, hitRate: g?.hitRate ?? null,
  };
}

/**
 * An intraday scanner setup: its ledger record as evidence (null when the ledger could not be read), and the daily
 * definition of its setup kind as the rule, studied over the universe: the daily version of the thesis, not a test
 * of the intraday setup. No rule when no definition names the kind on the opportunity's side.
 */
export function opportunitySignal(o: Opportunity, ledger: readonly LedgerStats[] | null = null): Unstudied {
  const edge = o.netEdgeBps == null ? "" : ` · net edge ${fixed(o.netEdgeBps, 0)} bps (${o.edgeBasis})`;
  const daily = definitionForKind(o.setupKind, o.direction);
  const rule = daily ? definitionRule(daily) : null;
  return {
    id: `opportunity:${o.coin}:${o.id}`, source: "opportunity", coin: o.coin, direction: o.direction,
    headline: `${o.setupKind} · ${o.status} · score ${o.score.toFixed(2)} · tier ${o.liquidityTier}${edge}`,
    tested: rule?.direction ?? null, scope: rule ? "universe" : "coin",
    at: Date.parse(o.createdAt), rule, ruleText: rule && ruleText(rule), href: `/feed?id=${o.id}`,
    evidence: ledger ? ledgerEvidence(o.setupKind, ledger) : null, definitionId: daily?.id ?? null,
  };
}

/** Scorecard horizon a radar call's evidence reads: the longest graded one (the kill-watch window). */
export const SCORECARD_HORIZON_DAYS = Math.max(...RADAR_HORIZONS);

/** The call's stance in the radar scorecard at SCORECARD_HORIZON_DAYS; null without a row (no graded call yet). */
export function scorecardEvidence(c: Pick<RadarCall, "stance">, rows: readonly RadarScoreRow[]): ScorecardEvidence | null {
  const r = rows.find((x) => x.stance === c.stance && x.horizonDays === SCORECARD_HORIZON_DAYS);
  return r ? { kind: "scorecard", stance: r.stance, horizonDays: r.horizonDays, n: r.n, meanPct: r.meanPct, hitRate: r.hits / r.n } : null;
}

/** A landed radar call: a dated catalyst thesis, graded forward by the scorecard, not replayed (rule null). The headline carries the code-stamped numbers only. */
export function radarSignal(c: RadarCall, scorecard: readonly RadarScoreRow[] = []): Unstudied {
  const graded = Object.entries(c.rel).map(([h, x]) => `+${h}d ${fixed(x, 1)}% vs BTC`);
  return {
    id: `radar:${c.market}:${c.id}`, source: "radar", coin: c.market, direction: c.direction,
    headline: [`${c.stance} ${c.direction} · ${c.kind}`, `mark ${c.mark}`, `kill ${c.kill_price}`, ...graded].join(" · "),
    at: Date.parse(c.at), rule: null, tested: null, scope: "coin", ruleText: null, href: null,
    evidence: scorecardEvidence(c, scorecard), definitionId: null,
  };
}
