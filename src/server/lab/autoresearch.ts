import { evaluateRule, priceReturns, project, ruleId, ruleText, stanceOf, trendSeries } from "./engine/index.js";
import { RuleSchema, type Fitness, type LabDataset, type Projection, type Rule, type RuleEvaluation, type Stance } from "./types.js";

// The autoresearch loop's fixed half (docs/AUTORESEARCH.md): the evaluator an
// agent may call but not edit. Pure: the script (scripts/autoresearch.ts) does
// the files. An agent sees walk-forward numbers only; the holdout is read once,
// by `finalReport`, after the loop has stopped.

export const SLIPPAGE_BPS = 10;
/** A candidate replaces its slot's best only by more than this: smaller gains are inside the noise of a re-run on new data. */
export const KEEP_MARGIN = 0.05;
/** Fewest trades a year in the walk-forward for a candidate to be scored at all. */
export const MIN_TRADES_PER_YEAR = 1;

export const TSV_HEADER = ["id", "slot", "fitness", "sharpe", "max_dd", "vol", "trades_per_year", "exposure", "status", "rule", "description"] as const;
export type Status = "keep" | "discard" | "invalid";

export interface Row {
  id: string;
  slot: string;
  fitness: number;
  sharpe: number;
  maxDrawdown: number;
  vol: number;
  tradesPerYear: number;
  exposure: number;
  status: Status;
  rule: Rule;
  description: string;
}

export const slotOf = (rule: Pick<Rule, "asset" | "direction">, domain: string) => `${rule.asset.toUpperCase()}/${rule.direction}/${domain}`;

/** What an agent is shown for one experiment: no holdout, no in-sample. */
export interface Experiment {
  id: string;
  text: string;
  fitness: Fitness;
  walkForward: NonNullable<RuleEvaluation["walkForward"]>;
  walkForwardFolds: (number | null)[];
  firingNow: boolean;
  /** Set when the candidate cannot be scored (it never trades, or too rarely). */
  invalid?: string;
}

export function runExperiment(input: unknown, data: LabDataset): Experiment {
  const rule = RuleSchema.parse(input);
  const ev = evaluateRule(rule, data, { slippageBps: SLIPPAGE_BPS, walkForward: true });
  const wf = ev.walkForward!;
  const fitness = ev.fitness!;
  const invalid = fitness.untested ? "never trades in the walk-forward" : wf.tradesPerYear < MIN_TRADES_PER_YEAR ? `${wf.tradesPerYear.toFixed(2)} trades a year in the walk-forward, under ${MIN_TRADES_PER_YEAR}` : undefined;
  return { id: ev.id, text: ev.text, fitness, walkForward: wf, walkForwardFolds: ev.walkForwardFolds ?? [], firingNow: ev.firingNow, ...(invalid && { invalid }) };
}

/** Best kept fitness of a slot so far; null when nothing was kept. */
export function slotBest(rows: Row[], slot: string): number | null {
  const kept = rows.filter((r) => r.slot === slot && r.status === "keep");
  return kept.length ? Math.max(...kept.map((r) => r.fitness)) : null;
}

/** Keep when valid, positive, and better than the slot's best by more than the margin. A repeat of a logged rule is discarded. */
export function decide(exp: Experiment, slot: string, rows: Row[]): { status: Status; why: string } {
  if (exp.invalid) return { status: "invalid", why: exp.invalid };
  if (rows.some((r) => r.id === exp.id && r.slot === slot)) return { status: "discard", why: "already tried" };
  const s = exp.fitness.score;
  if (!(s > 0)) return { status: "discard", why: `fitness ${s.toFixed(3)} ≤ 0` };
  const best = slotBest(rows, slot);
  if (best != null && !(s > best + KEEP_MARGIN)) return { status: "discard", why: `fitness ${s.toFixed(3)} does not beat ${best.toFixed(3)} by more than ${KEEP_MARGIN}` };
  return { status: "keep", why: best == null ? "first kept rule of the slot" : `fitness ${s.toFixed(3)} > ${best.toFixed(3)} + ${KEEP_MARGIN}` };
}

const clean = (s: string) => s.replace(/[\t\r\n]+/g, " ").trim();

export function toTsv(r: Row): string {
  return [r.id, r.slot, r.fitness.toFixed(4), r.sharpe.toFixed(4), r.maxDrawdown.toFixed(4), r.vol.toFixed(4), r.tradesPerYear.toFixed(2), r.exposure.toFixed(4), r.status, JSON.stringify(r.rule), clean(r.description)].join("\t");
}

export function parseTsv(text: string): Row[] {
  return text
    .split("\n")
    .slice(1)
    .filter((l) => l.trim())
    .map((l) => {
      const c = l.split("\t");
      return { id: c[0]!, slot: c[1]!, fitness: +c[2]!, sharpe: +c[3]!, maxDrawdown: +c[4]!, vol: +c[5]!, tradesPerYear: +c[6]!, exposure: +c[7]!, status: c[8] as Status, rule: JSON.parse(c[9]!) as Rule, description: c[10] ?? "" };
    });
}

export function rowOf(exp: Experiment, rule: Rule, slot: string, status: Status, description: string): Row {
  return { id: exp.id, slot, fitness: exp.fitness.score, sharpe: exp.fitness.sharpe, maxDrawdown: exp.fitness.maxDrawdown, vol: exp.fitness.vol, tradesPerYear: exp.walkForward.tradesPerYear, exposure: exp.walkForward.exposure, status, rule, description };
}

/** The last kept row of each slot: its champion. */
export function champions(rows: Row[]): Row[] {
  const by = new Map<string, Row>();
  for (const r of rows) if (r.status === "keep") by.set(r.slot, r);
  return [...by.values()].sort((a, b) => b.fitness - a.fitness);
}

export interface FinalReport {
  asset: string;
  asOf: string;
  experiments: number;
  champions: Array<{ slot: string; description: string; evaluation: RuleEvaluation }>;
  stance: Stance;
  projection: Projection & { price: number };
}

/**
 * The one read of the holdout: every champion for the asset evaluated in full,
 * its deflated Sharpe against N = all experiments logged for the asset, then
 * the stance from those rules and the projection.
 */
export function finalReport(asset: string, rows: Row[], data: LabDataset, opts: { horizonDays?: number; paths?: number; seed?: number } = {}): FinalReport {
  const mine = rows.filter((r) => r.rule.asset.toUpperCase() === asset.toUpperCase());
  const evals = champions(mine).map((c) => ({
    slot: c.slot,
    description: c.description,
    evaluation: evaluateRule(c.rule, data, { slippageBps: SLIPPAGE_BPS, walkForward: true, windows: [7, 30, 90], trials: Math.max(1, mine.length) }),
  }));
  const trend = trendSeries(data.price);
  const asOf = new Date(data.t.at(-1)!).toISOString().slice(0, 10);
  return {
    asset,
    asOf,
    experiments: mine.length,
    champions: evals,
    stance: stanceOf(asset, asOf, trend.at(-1) ?? null, evals.map((e) => e.evaluation)),
    projection: { price: data.price.at(-1)!, ...project(priceReturns(data.price), trend, { horizonDays: opts.horizonDays ?? 30, paths: opts.paths ?? 1000, seed: opts.seed ?? 42 }) },
  };
}

export { ruleId, ruleText };
