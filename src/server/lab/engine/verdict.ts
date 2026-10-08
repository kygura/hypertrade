import { VERDICT_LEVELS, type RuleEvaluation, type Verdict, type VerdictLevel } from "../types.js";

// The save bar as a verdict (LAB.md §7, "Verdict"). Checks run in order and
// the first that fails sets the level; `reasons` names every failed check.
//   fails_holdout  holdout missing, untested (no trade) or Sharpe ≤ 0
//   weak           walk-forward missing or Sharpe ≤ 1
//   fragile        stability < 0.5 (only when a sensitivity grid is attached)
//   candidate      deflated Sharpe missing or below MIN_DEFLATED_SHARPE
//   robust         everything passes: the save bar

/**
 * Deflated-Sharpe cut-off of the save bar, calibrated on synthetic searches
 * (LAB.md "Calibration"): the lowest of {0.5, 0.8, 0.9, 0.95} at which no
 * more than 1 in 20 pure-noise searches has any top-10 rule passing the full
 * bar, which keeps the most planted rules.
 */
export const MIN_DEFLATED_SHARPE = 0.9;
export const MIN_WALK_FORWARD_SHARPE = 1;
export const MIN_STABILITY = 0.5;

/** Rank of a level, robust = 4 … fails_holdout = 0: higher is better. */
export function verdictRank(level: VerdictLevel): number {
  return VERDICT_LEVELS.length - 1 - VERDICT_LEVELS.indexOf(level);
}

const f2 = (x: number) => x.toFixed(2);
/** x for a "x < bar" reason: 3 decimals when 2 would round it up to the bar. */
const below = (x: number, bar: number) => (Number(x.toFixed(2)) >= bar ? x.toFixed(3) : x.toFixed(2));

type VerdictInput = Pick<RuleEvaluation, "holdout" | "walkForward" | "sensitivity" | "deflatedSharpe">;

export function verdictOf(ev: VerdictInput, minDeflatedSharpe = MIN_DEFLATED_SHARPE): Verdict {
  const failed: Array<[VerdictLevel, string]> = [];
  const ho = ev.holdout;
  if (!ho) failed.push(["fails_holdout", "no holdout"]);
  else if (ho.untested) failed.push(["fails_holdout", "holdout untested (no trade)"]);
  else if (!(ho.sharpe > 0)) failed.push(["fails_holdout", `holdout Sharpe ${f2(ho.sharpe)} ≤ 0`]);
  const wf = ev.walkForward;
  if (!wf) failed.push(["weak", "no walk-forward"]);
  else if (!(wf.sharpe > MIN_WALK_FORWARD_SHARPE)) failed.push(["weak", `walk-forward Sharpe ${f2(wf.sharpe)} ≤ ${MIN_WALK_FORWARD_SHARPE}`]);
  const st = ev.sensitivity?.stability;
  if (st != null && !(st >= MIN_STABILITY)) failed.push(["fragile", `stability ${below(st, MIN_STABILITY)} < ${MIN_STABILITY}`]);
  const dsr = ev.deflatedSharpe;
  if (dsr == null) failed.push(["candidate", "deflated Sharpe not computed"]);
  else if (!(dsr >= minDeflatedSharpe)) failed.push(["candidate", `deflated Sharpe ${below(dsr, minDeflatedSharpe)} < ${minDeflatedSharpe}`]);
  const reasons = failed.map(([, r]) => r);
  if (st == null) reasons.push("stability not measured (no sensitivity grid)");
  return { level: failed[0]?.[0] ?? "robust", reasons };
}

/** The evaluation with its verdict attached (recomputed, so stale stored verdicts are replaced). */
export function withVerdict<T extends VerdictInput & { verdict?: Verdict }>(ev: T): T {
  return { ...ev, verdict: verdictOf(ev) };
}
