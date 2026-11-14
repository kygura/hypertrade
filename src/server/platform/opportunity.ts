import { isExtremesOpportunity } from "../../shared/extremes.js";
import type { Costs, Opportunity, OpportunityStatus } from "../../shared/platform.js";

/** EXTREMES_READY_TTL_H default: an extremes `take` stays approvable this long after it became ready. */
export const DEFAULT_EXTREMES_READY_TTL_H = 4;
/** EXTREMES_READY_TTL_H in minutes (a positive number of hours, else the default). */
export function extremesReadyTtlMin(env: Record<string, string | undefined> = process.env): number {
  const h = Number(env.EXTREMES_READY_TTL_H?.trim());
  return (env.EXTREMES_READY_TTL_H?.trim() && Number.isFinite(h) && h > 0 ? h : DEFAULT_EXTREMES_READY_TTL_H) * 60;
}
/**
 * The ready TTL that applies to `o`: an extremes take (shared/extremes.ts isExtremesOpportunity) has its own
 * (EXTREMES_READY_TTL_H); every other row the scanner's PLATFORM_READY_TTL_MIN. One rule for every place that expires.
 */
export const readyTtlMinFor = (o: Pick<Opportunity, "scoreVersion" | "setupKind">, ttl: { scannerMin: number; extremesMin: number }) =>
  isExtremesOpportunity(o) ? ttl.extremesMin : ttl.scannerMin;

/** P0.11: a ready idea expires after ttlMin without a decision. Measured from statusChangedAt (set on creation and every status move, never by a rescan). */
export function shouldExpire(opp: Pick<Opportunity, "status" | "statusChangedAt">, now: Date, ttlMin: number): boolean {
  if (opp.status !== "ready" || !(ttlMin >= 0)) return false;
  const t = Date.parse(opp.statusChangedAt);
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
