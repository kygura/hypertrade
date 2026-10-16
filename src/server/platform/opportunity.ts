import { OPPORTUNITY_TRANSITIONS, type Costs, type Opportunity, type OpportunityStatus } from "../../shared/platform.js";

export const canTransition = (from: OpportunityStatus, to: OpportunityStatus) => OPPORTUNITY_TRANSITIONS[from].includes(to);

/** P0.11: a ready idea expires after ttlMin without a decision. Measured from updatedAt (the contract has no readyAt). */
export function shouldExpire(opp: Pick<Opportunity, "status" | "updatedAt">, now: Date, ttlMin: number): boolean {
  if (opp.status !== "ready" || !(ttlMin >= 0)) return false;
  const t = Date.parse(opp.updatedAt);
  return Number.isFinite(t) && now.getTime() - t >= ttlMin * 60_000;
}

/**
 * Next status code may set on its own. Never approved/rejected/expired (operator or TTL paths).
 * `researchScore` is the PLATFORM_RESEARCH_SCORE threshold.
 */
export function nextAutoStatus(
  opp: { status: OpportunityStatus; score: number; costs: Costs | null },
  ctx: { researchScore: number; researchAllowed: boolean },
): OpportunityStatus | null {
  if (opp.status === "new" && opp.score >= ctx.researchScore && ctx.researchAllowed) return "investigating";
  if ((opp.status === "new" || opp.status === "investigating") && opp.costs) return "calculated";
  if (opp.status === "calculated" && opp.costs) return "ready";
  return null;
}
