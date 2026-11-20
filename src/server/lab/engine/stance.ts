import type { Direction, RuleEvaluation, SideEdge, Stance, Trend } from "../types.js";
import { FITNESS } from "./fitness.js";

// Does it pay to be long or short now (docs/AUTORESEARCH.md "Stance")? Read only
// from rules that fire on the latest bar, and only from what each earned out of
// sample (walk-forward) on days in today's trend regime.

type StanceInput = Pick<RuleEvaluation, "id" | "text" | "rule" | "firingNow" | "fitness">;

function sideEdge(evals: StanceInput[], direction: Direction, trend: Trend | null): SideEdge {
  const mine = evals.filter((e) => e.rule.direction === direction);
  const firing = mine.filter((e) => e.firingNow);
  let days = 0;
  let sum = 0;
  const used: SideEdge["rules"] = [];
  for (const e of firing) {
    const f = e.fitness;
    const r = trend ? f?.regimes.find((x) => x.trend === trend) : undefined;
    const counts = !!f && !f.untested && f.score > 0 && !!r && r.days >= FITNESS.minRegimeDays;
    used.push({ id: e.id, text: e.text, fitness: f?.score ?? null, regimeDays: r?.days ?? 0, regimeMeanDailyBps: r ? r.meanDaily * 1e4 : null, counted: counts });
    if (!counts) continue;
    days += r.days;
    sum += r.meanDaily * r.days;
  }
  return { total: mine.length, firing: firing.length, counted: used.filter((u) => u.counted).length, days, meanDailyBps: days ? (sum / days) * 1e4 : null, rules: used };
}

/**
 * A side pays when the rules firing for it, weighted by their days in today's
 * regime, earned a positive net daily return there. Both pay: the larger edge,
 * and the reasons say they disagree. Neither: flat.
 */
export function stanceOf(asset: string, asOf: string, trend: Trend | null, evals: StanceInput[]): Stance {
  const long = sideEdge(evals, "long", trend);
  const short = sideEdge(evals, "short", trend);
  const pays = (s: SideEdge) => s.meanDailyBps != null && s.meanDailyBps > 0;
  const bps = (s: SideEdge) => `${s.meanDailyBps!.toFixed(1)} bps/day over ${s.days} regime days, ${s.counted} rule${s.counted === 1 ? "" : "s"}`;
  const reasons: string[] = [];
  let side: Stance["side"] = "flat";
  if (!trend) reasons.push("trend regime unknown (under 50 days of price)");
  for (const [name, s] of [["long", long], ["short", short]] as const) {
    if (!s.total) reasons.push(`no ${name} rule to read`);
    else if (!s.firing) reasons.push(`no ${name} rule fires (0 of ${s.total})`);
    else if (!s.counted) reasons.push(`${s.firing} ${name} rule${s.firing === 1 ? "" : "s"} firing, none with positive fitness and ${FITNESS.minRegimeDays}+ days in this regime`);
    else reasons.push(`${name}: ${bps(s)}`);
  }
  if (pays(long) && pays(short)) {
    side = long.meanDailyBps! >= short.meanDailyBps! ? "long" : "short";
    reasons.push("both sides have firing rules with a positive edge; the larger one is taken");
  } else if (pays(long)) side = "long";
  else if (pays(short)) side = "short";
  return { asset, asOf, trend, side, long, short, reasons };
}
