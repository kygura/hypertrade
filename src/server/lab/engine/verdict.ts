import { VERDICT_LEVELS, type RuleEvaluation, type Verdict, type VerdictLevel } from "../types.js";

// The save bar as a verdict (docs/LAB.md §7, "Verdict"). Checks run in order and
// the first that fails sets the level; `reasons` names every failed check.
//   fails_holdout  holdout missing, untested (no trade), Sharpe ≤ 0 or excess Sharpe ≤ 0
//   weak           walk-forward missing, Sharpe ≤ 1 or excess Sharpe ≤ 1
//   fragile        stability < 0.5 (only when a sensitivity grid is attached)
//   candidate      deflated Sharpe missing, undefined or below MIN_DEFLATED_SHARPE,
//                  or no excess measured (stats stored before the benchmark gate)
//   robust         everything passes: the save bar
// "Excess" is over the exposure-matched benchmark of the same days (backtest.ts
// excessReturns), and the deflated Sharpe is taken on that excess track: the
// asset's own drift earns a rule nothing, so a long rule on a rising asset is
// not robust for being long.

/**
 * Deflated-Sharpe cut-off of the save bar, calibrated on synthetic searches
 * (docs/LAB.md "Calibration"): the lowest of {0.5, 0.8, 0.9, 0.95} at which no
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
  else {
    if (!(ho.sharpe > 0)) failed.push(["fails_holdout", `holdout Sharpe ${f2(ho.sharpe)} ≤ 0`]);
    if (ho.excessSharpe != null && !(ho.excessSharpe > 0)) failed.push(["fails_holdout", `holdout excess Sharpe over the benchmark ${f2(ho.excessSharpe)} ≤ 0`]);
  }
  const wf = ev.walkForward;
  if (!wf) failed.push(["weak", "no walk-forward"]);
  else {
    if (!(wf.sharpe > MIN_WALK_FORWARD_SHARPE)) failed.push(["weak", `walk-forward Sharpe ${f2(wf.sharpe)} ≤ ${MIN_WALK_FORWARD_SHARPE}`]);
    if (wf.excessSharpe != null && !(wf.excessSharpe > MIN_WALK_FORWARD_SHARPE)) {
      failed.push(["weak", `walk-forward excess Sharpe over the benchmark ${f2(wf.excessSharpe)} ≤ ${MIN_WALK_FORWARD_SHARPE}`]);
    }
  }
  const st = ev.sensitivity?.stability;
  if (st != null && !(st >= MIN_STABILITY)) failed.push(["fragile", `stability ${below(st, MIN_STABILITY)} < ${MIN_STABILITY}`]);
  const dsr = ev.deflatedSharpe;
  // With a walk-forward of 4+ days, null is an undefined DSR (stats.ts); absent (old evaluations) is not computed.
  if (dsr == null) failed.push(["candidate", dsr === null && wf && wf.days >= 4 ? "deflated Sharpe undefined (extreme skew/kurtosis)" : "deflated Sharpe not computed"]);
  else if (!(dsr >= minDeflatedSharpe)) failed.push(["candidate", `deflated Sharpe ${below(dsr, minDeflatedSharpe)} < ${minDeflatedSharpe}`]);
  // Stats stored before the benchmark gate carry no excess: their numbers cannot show the rule beat holding the asset.
  if ((ho && !ho.untested && ho.excessSharpe == null) || (wf && wf.excessSharpe == null)) {
    failed.push(["candidate", "excess over the benchmark not measured (evaluated before the benchmark gate; re-evaluate)"]);
  }
  const reasons = failed.map(([, r]) => r);
  if (st == null) reasons.push("stability not measured (no sensitivity grid)");
  return { level: failed[0]?.[0] ?? "robust", reasons };
}

/**
 * A stored evaluation with the verdict it earns on today's bar. One stored with `costs` was judged on this bar and
 * keeps its verdict. One without predates the excess bar (raw Sharpe, slippage only) or verdicts altogether: its
 * verdict is recomputed from its stats, which carry no excess, so it is at most `candidate` with the reason to
 * re-evaluate. A read-side view: nothing stored is rewritten.
 */
export function currentVerdict<T extends VerdictInput & { verdict?: Verdict; costs?: unknown }>(ev: T): T {
  return ev.verdict && ev.costs ? ev : withVerdict(ev);
}

/** The evaluation with its verdict attached (recomputed, so stale stored verdicts are replaced). */
export function withVerdict<T extends VerdictInput & { verdict?: Verdict }>(ev: T): T {
  return { ...ev, verdict: verdictOf(ev) };
}
