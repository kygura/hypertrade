import type { ActiveLocks, DeskPlanInput, PlanCheck, PlanMetrics, PlanRung } from "../../shared/deskPlan.js";
import type { GovernorLimits, PlanRules } from "./config.js";
import { lockReasons } from "./cooldown.js";
import { dailyPossibleLossReason } from "./governor.js";
import type { AccountState } from "./types.js";

// The calm desk's plan check, pure: an order is placed only from a written plan (coin, side, a ladder of rungs, a
// stop and a target). checkPlan computes the plan's numbers (shared/deskPlan.ts PlanMetrics documents each) and
// the reasons it cannot be submitted. DeskService.checkPlan adds the venue's limits and the governor's verdict.

export interface PlanContext {
  account: AccountState;
  limits: Pick<GovernorLimits, "maxRiskPct" | "dailyLossLimitPct" | "minRewardRisk">;
  rules: Pick<PlanRules, "maxRiskPct" | "maxDrawdownPct">;
  locks: ActiveLocks;
  /** Base of the max drawdown in USD (Propr: the starting balance); defaults to equity. */
  drawdownBaseUsd?: number;
  markPx?: number | null;
}

const r2 = (x: number) => Math.round(x * 100) / 100;
const r4 = (x: number) => Math.round(x * 1e4) / 1e4;

/** The first rung to fill as price moves from the mark toward the stop: a long's highest rung, a short's lowest. */
export function topRung(input: Pick<DeskPlanInput, "side" | "rungs">): PlanRung {
  return input.rungs.reduce((best, r) => ((input.side === "long" ? r.px > best.px : r.px < best.px) ? r : best));
}

/** Loss per unit if a rung at `px` fills and the stop is hit (negative when the stop is on the wrong side). */
const lossPerUnit = (side: DeskPlanInput["side"], px: number, stop: number) => (side === "long" ? px - stop : stop - px);
const rewardPerUnit = (side: DeskPlanInput["side"], px: number, target: number) => (side === "long" ? target - px : px - target);

export function planMetrics(input: DeskPlanInput, ctx: PlanContext): PlanMetrics {
  const equity = ctx.account.equityUsd;
  const totalSize = input.rungs.reduce((a, r) => a + r.size, 0);
  const notional = input.rungs.reduce((a, r) => a + r.px * r.size, 0);
  const avg = notional / totalSize;
  const top = topRung(input);
  const stop = input.stopPx;
  const target = input.targetPx;
  const loss = stop == null ? null : input.rungs.reduce((a, r) => a + r.size * lossPerUnit(input.side, r.px, stop), 0);
  const rr = (px: number) => {
    if (stop == null || target == null) return null;
    const risk = lossPerUnit(input.side, px, stop);
    return risk > 0 ? r2(rewardPerUnit(input.side, px, target) / risk) : null;
  };
  const pctOfEquity = (usd: number | null) => (usd == null || !(equity > 0) ? null : r4((usd / equity) * 100));
  const dayLimit = (ctx.limits.dailyLossLimitPct / 100) * equity;
  const ddBase = ctx.drawdownBaseUsd ?? equity;
  const ddLimit = (ctx.rules.maxDrawdownPct / 100) * ddBase;
  return {
    totalSize: r4(totalSize),
    notionalUsd: r2(notional),
    avgEntryPx: avg,
    topRungPx: top.px,
    lossAtStopUsd: loss == null ? null : r2(loss),
    lossAtStopPct: pctOfEquity(loss),
    rrFull: rr(avg),
    rrTopOnly: rr(top.px),
    dailyLimitUsedPct: loss == null || !(dayLimit > 0) ? null : r2(((Math.max(0, -ctx.account.dayPnlUsd) + loss) / dayLimit) * 100),
    drawdownUsedPct: loss == null || !(ddLimit > 0) ? null : r2((loss / ddLimit) * 100),
    equityUsd: r2(equity),
    markPx: ctx.markPx ?? null,
  };
}

/** The plan's numbers and every reason it cannot be submitted (empty blockers: submittable as far as the plan rules go). */
export function checkPlan(input: DeskPlanInput, ctx: PlanContext): PlanCheck {
  const m = planMetrics(input, ctx);
  const blockers: string[] = [];
  const warnings: string[] = [];
  const long = input.side === "long";
  const prices = input.rungs.map((r) => r.px);
  const low = Math.min(...prices);
  const high = Math.max(...prices);

  blockers.push(...lockReasons(ctx.locks, input.coin));
  if (input.stopPx == null) blockers.push("no stop: every plan needs one");
  else if (long ? !(input.stopPx < low) : !(input.stopPx > high)) {
    blockers.push(`stop ${input.stopPx} must be ${long ? "below every rung (lowest" : "above every rung (highest"} ${long ? low : high}) for a ${input.side}`);
  }
  if (input.targetPx == null) blockers.push("no target: every plan needs one");
  else if (long ? !(input.targetPx > high) : !(input.targetPx < low)) {
    blockers.push(`target ${input.targetPx} must be ${long ? "above every rung (highest" : "below every rung (lowest"} ${long ? high : low}) for a ${input.side}`);
  }
  if (!ctx.account.available || !(ctx.account.equityUsd > 0)) blockers.push(`account unavailable${ctx.account.note ? `: ${ctx.account.note}` : ""}: risk cannot be measured`);

  if (m.lossAtStopUsd != null && m.lossAtStopUsd > 0 && m.lossAtStopPct != null) {
    // The plan cap and the governor's per-trade limit both apply; the tighter one is named.
    const planCap = ctx.rules.maxRiskPct;
    const govCap = ctx.limits.maxRiskPct;
    if (m.lossAtStopPct > Math.min(planCap, govCap) + 1e-9) {
      blockers.push(
        govCap < planCap
          ? `loss at stop ${m.lossAtStopPct}% of equity is over the governor's ${govCap}% per-trade limit (DESK_MAX_RISK_PCT)`
          : `loss at stop ${m.lossAtStopPct}% of equity is over the ${planCap}% per-trade cap (DESK_PLAN_MAX_RISK_PCT)`,
      );
    }
    const daily = dailyPossibleLossReason(ctx.account, m.lossAtStopUsd, ctx.limits);
    if (daily) blockers.push(daily);
  }
  if (m.rrTopOnly != null && m.rrFull != null && m.rrTopOnly < ctx.limits.minRewardRisk && input.rungs.length > 1) {
    warnings.push(`if only the top rung (${m.topRungPx}) fills, reward:risk is ${m.rrTopOnly}, under ${ctx.limits.minRewardRisk}`);
  }
  if (m.drawdownUsedPct != null && m.drawdownUsedPct >= 25) warnings.push(`this stop uses ${m.drawdownUsedPct}% of the account's max drawdown`);
  return { metrics: m, blockers, warnings };
}
