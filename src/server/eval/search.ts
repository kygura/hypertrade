// The autoresearch loop (docs/EVAL.md §5), after karpathy/autoresearch: the harness (data, regimes, objective, split)
// is fixed, only the strategy spec changes; each experiment runs under the same budget, is scored by the same number,
// and is kept only if it beats the best so far, else discarded; every experiment is one row of results.tsv. In
// autoresearch an LLM edits train.py; here the "edit" is a new spec, proposed either by an agent (`propose`, see
// docs/eval/program.md) or by the built-in mutator below, which is what the scheduled refresh uses.
import { fork, gauss, mulberry32, type Rng } from "../lab/engine/rng.js";
import { deflated, evaluate, foldScore, splitOf, type Metrics, type Split } from "./objective.js";
import type { EvalPanel } from "./panel.js";
import { labelRegimes, REGIMES, type Regime } from "./regimes.js";
import { DEFAULT_SPECS, FAMILIES, normalizeSpec, OVERLAY_SPACE, PARAM_SPACE, positions, specKey, type Family, type StrategySpec } from "./strategies.js";

/** Days every series needs before the first scored day (200-day mean, 155-day cost basis, 365-day high). */
export const WARMUP_DAYS = 200;

export interface EvalContext {
  panel: EvalPanel;
  regimes: Regime[];
  split: Split;
}

export function contextOf(panel: EvalPanel, holdoutFrac?: number): EvalContext {
  const regimes = labelRegimes(panel);
  const first = Math.max(0, panel.price.findIndex((x) => Number.isFinite(x)));
  return { panel, regimes, split: splitOf(panel.price.length, Math.min(panel.price.length - 10, first + WARMUP_DAYS), undefined, holdoutFrac) };
}

export interface Scored {
  spec: StrategySpec;
  key: string;
  /** Mean over the contexts (assets) of each one's fold score. */
  score: number;
  perAsset: Record<string, { score: number; insample: Metrics }>;
}

/** Whether [a, b) has the inputs the spec's family reads (funding needs at least half its days). */
export function hasInputs(spec: StrategySpec, panel: EvalPanel, a: number, b: number): boolean {
  if (spec.family !== "funding") return true;
  let n = 0;
  for (let i = a; i < b; i++) if (Number.isFinite(panel.funding[i]!)) n++;
  return n >= (b - a) / 2;
}

/**
 * Assets are weighted by √(scored days), so a young asset (HYPE has about a fifth of BTC's history) counts but does not
 * set the ranking on its own, as an equal weight let it do.
 */
export function assetWeight(days: number): number {
  return days > 0 ? Math.sqrt(days) : 0;
}

export function scoreSpec(spec: StrategySpec, ctxs: readonly EvalContext[]): Scored {
  const s = normalizeSpec(spec);
  const perAsset: Scored["perAsset"] = {};
  let tot = 0;
  let wt = 0;
  for (const c of ctxs) {
    const fs = foldScore(c.panel, positions(s, c.panel, c.regimes), c.regimes, c.split, (a, b) => hasInputs(s, c.panel, a, b));
    perAsset[c.panel.asset] = { score: fs.score, insample: fs.insample };
    if (!Number.isFinite(fs.score)) continue;
    const w = assetWeight(fs.days);
    tot += w * fs.score;
    wt += w;
  }
  return { spec: s, key: specKey(s), score: wt > 0 ? tot / wt : -Infinity, perAsset };
}

export type Status = "keep" | "discard" | "crash" | "baseline";

export interface Experiment {
  n: number;
  family: Family;
  key: string;
  score: number;
  sharpe: number;
  maxDD: number;
  cvar95: number;
  ivCarry: number;
  status: Status;
  description: string;
}

export const TSV_HEADER = "n\tfamily\tscore\tsharpe\tmax_dd\tcvar95\tiv_carry\tstatus\tspec\tdescription";

export function tsvRow(e: Experiment): string {
  const f = (x: number, d = 4) => (Number.isFinite(x) ? x.toFixed(d) : "nan");
  return [e.n, e.family, f(e.score), f(e.sharpe, 3), f(e.maxDD, 3), f(e.cvar95, 4), f(e.ivCarry, 3), e.status, e.key, e.description.replace(/\s+/g, " ")].join("\t");
}

/** Mean of a metric over the assets of a scored spec (in-sample). */
export function avg(s: Scored, k: "sharpe" | "maxDD" | "cvar95" | "ivCarry"): number {
  const v = Object.values(s.perAsset).filter((x) => Number.isFinite(x.score));
  return v.length ? v.reduce((t, x) => t + x.insample[k], 0) / v.length : NaN;
}

/** The built-in proposer: perturb the family's best spec, sometimes restart, sometimes change the regime gate or side. */
export function mutate(best: StrategySpec, rng: Rng): { spec: StrategySpec; description: string } {
  const space = { ...PARAM_SPACE[best.family], ...OVERLAY_SPACE };
  const roll = rng();
  if (roll < 0.12) {
    const params: Record<string, number> = {};
    for (const [k, r] of Object.entries(space)) params[k] = r.lo + rng() * (r.hi - r.lo);
    return { spec: normalizeSpec({ family: best.family, params }), description: "random restart" };
  }
  if (roll < 0.22) {
    const pick = REGIMES.filter(() => rng() < 0.5);
    return { spec: normalizeSpec({ ...best, regimes: pick.length && pick.length < REGIMES.length ? [...pick] : undefined }), description: `gate ${pick.join("|") || "all"}` };
  }
  if (roll < 0.28 && best.family !== "capitulation" && best.family !== "hold") {
    return { spec: normalizeSpec({ ...best, short: !best.short }), description: best.short ? "long only" : "allow shorts" };
  }
  const params = { ...best.params };
  const changed: string[] = [];
  for (const [k, r] of Object.entries(space)) {
    if (rng() < 0.5) continue;
    params[k] = (params[k] ?? r.lo) + gauss(rng) * 0.15 * (r.hi - r.lo);
    changed.push(k);
  }
  if (!changed.length) {
    const ks = Object.keys(space);
    if (ks.length) {
      const k = ks[Math.floor(rng() * ks.length)]!;
      params[k] = (params[k] ?? space[k]!.lo) + gauss(rng) * 0.15 * (space[k]!.hi - space[k]!.lo);
      changed.push(k);
    }
  }
  return { spec: normalizeSpec({ ...best, params }), description: `tweak ${changed.join(",")}` };
}

export interface SearchOptions {
  families?: readonly Family[];
  seed?: number;
  /** Stop after this many experiments… */
  maxExperiments?: number;
  /** …or once this much wall time has passed (ms), whichever is first. */
  budgetMs?: number;
  /** Start points per family (default DEFAULT_SPECS). */
  start?: Partial<Record<Family, StrategySpec>>;
  /** An agent's proposer; undefined = the built-in mutator. Return null to fall back to it for that step. */
  propose?: (family: Family, best: Scored, history: readonly Experiment[]) => { spec: StrategySpec; description: string } | null;
  now?: () => number;
  onExperiment?: (e: Experiment) => void;
  /** Number of the first row (rows already in results.tsv), so `n` keeps counting across runs. */
  firstN?: number;
}

export interface SearchResult {
  best: Partial<Record<Family, Scored>>;
  log: Experiment[];
  trials: number;
}

export function runSearch(ctxs: readonly EvalContext[], o: SearchOptions = {}): SearchResult {
  const families = o.families?.length ? o.families : FAMILIES;
  const rng = mulberry32(o.seed ?? 1);
  const now = o.now ?? Date.now;
  const t0 = now();
  const max = o.maxExperiments ?? 400;
  const log: Experiment[] = [];
  const best: SearchResult["best"] = {};
  const seen = new Set<string>();
  const record = (s: Scored, status: Status, description: string) => {
    const e: Experiment = {
      n: (o.firstN ?? 0) + log.length,
      family: s.spec.family,
      key: s.key,
      score: s.score,
      sharpe: avg(s, "sharpe"),
      maxDD: avg(s, "maxDD"),
      cvar95: avg(s, "cvar95"),
      ivCarry: avg(s, "ivCarry"),
      status,
      description,
    };
    log.push(e);
    o.onExperiment?.(e);
  };
  for (const f of families) {
    const s = scoreSpec(o.start?.[f] ?? DEFAULT_SPECS[f], ctxs);
    best[f] = s;
    seen.add(s.key);
    record(s, "baseline", "start");
  }
  const rngs = Object.fromEntries(families.map((f) => [f, fork(rng)])) as Record<Family, Rng>;
  const tunable = families.filter((f) => f !== "hold");
  let i = 0;
  let attempts = 0;
  while (tunable.length && log.length < max && attempts++ < max * 5 && (o.budgetMs === undefined || now() - t0 < o.budgetMs)) {
    const f = tunable[i++ % tunable.length]!;
    const cur = best[f]!;
    let prop = o.propose?.(f, cur, log) ?? null;
    if (!prop) prop = mutate(cur.spec, rngs[f]);
    let s: Scored;
    try {
      s = scoreSpec(prop.spec, ctxs);
    } catch (err) {
      log.push({ n: (o.firstN ?? 0) + log.length, family: f, key: specKey(prop.spec), score: NaN, sharpe: NaN, maxDD: NaN, cvar95: NaN, ivCarry: NaN, status: "crash", description: String(err) });
      continue;
    }
    if (seen.has(s.key)) continue;
    seen.add(s.key);
    if (s.score > cur.score) {
      best[f] = s;
      record(s, "keep", prop.description);
    } else record(s, "discard", prop.description);
  }
  return { best, log, trials: log.filter((e) => e.status !== "crash").length };
}

export interface Finalist {
  spec: StrategySpec;
  key: string;
  searchScore: number;
  holdout: Record<string, Metrics & { deflatedSharpe: number | null }>;
  /** Holdout score over the assets, weighted as in the search (assets without the spec's inputs are left out). */
  holdoutScore: number;
  /** The spec's position on each asset's last day (information, not an order). */
  now: Record<string, number>;
}

/** Scores each family's best on the untouched holdout, with the deflated Sharpe for the number of trials. */
export function finalize(res: SearchResult, ctxs: readonly EvalContext[]): Finalist[] {
  const out: Finalist[] = [];
  for (const s of Object.values(res.best)) {
    if (!s) continue;
    const holdout: Finalist["holdout"] = {};
    const now: Record<string, number> = {};
    let tot = 0;
    let wt = 0;
    for (const c of ctxs) {
      const pos = positions(s.spec, c.panel, c.regimes);
      const m = evaluate(c.panel, pos, c.regimes, c.split.holdout, c.split.end);
      holdout[c.panel.asset] = { ...m, deflatedSharpe: deflated(c.panel, pos, c.split, res.trials) };
      now[c.panel.asset] = Math.round((pos[pos.length - 1] ?? 0) * 1000) / 1000;
      if (!hasInputs(s.spec, c.panel, c.split.holdout, c.split.end)) continue;
      const w = assetWeight(m.days);
      tot += w * m.score;
      wt += w;
    }
    out.push({ spec: s.spec, key: s.key, searchScore: s.score, holdout, holdoutScore: wt > 0 ? tot / wt : NaN, now });
  }
  return out.sort((a, b) => (Number.isFinite(b.holdoutScore) ? b.holdoutScore : -Infinity) - (Number.isFinite(a.holdoutScore) ? a.holdoutScore : -Infinity));
}
