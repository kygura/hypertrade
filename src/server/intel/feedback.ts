import { EDGE_TYPE_WEIGHT, type FeedbackBucket, type FeedbackReport } from "../../shared/intel.js";
import { DAMPEN_MIN_VOTES, DAMPEN_NET, dampened } from "./mapper.js";
import type { IntelStore } from "./store.js";

// Weekly feedback report (SPEC.md § Intel I0.12). Code only, no LLM: votes
// on the last 7 days of alerts, per (event type, edge type, hops), the worst
// buckets first, each with a suggested adjustment the operator can apply by
// hand. No auto-tuning beyond the mapper's push dampening (mapper.ts).

export const REPORT_PERIOD_MS = 7 * 86_400_000;
export const WORST_K = 5;

export interface FeedbackDeps {
  store: Pick<IntelStore, "feedbackStats" | "insertReport">;
  now(): Date;
  /** INTEL_PUSH_MATERIALITY in force, quoted in suggestions. */
  pushMateriality?: number;
}

/** Buckets with more downvotes than upvotes, by net share (worst first), then by votes. Pure. */
export function worstBuckets(stats: FeedbackBucket[], k = WORST_K): FeedbackBucket[] {
  const net = (b: FeedbackBucket) => (b.up - b.down) / (b.up + b.down);
  return stats
    .filter((b) => b.down > b.up)
    .sort((a, b) => net(a) - net(b) || b.up + b.down - (a.up + a.down))
    .slice(0, k);
}

/** One concrete, code-written tuning suggestion for a bucket. Pure. */
export function suggestAdjustment(b: FeedbackBucket, pushMateriality?: number): string {
  const ev = b.eventType ?? "unclassified";
  const votes = b.up + b.down;
  const thin = votes < DAMPEN_MIN_VOTES ? ` (only ${votes} vote${votes === 1 ? "" : "s"}: watch before changing)` : "";
  const damp = dampened([b], b.eventType, b.edgeType, b.hops) ? ` Pushes here are already batched (net ≤ ${Math.round(DAMPEN_NET * 100)}%).` : "";
  const push = pushMateriality == null ? "INTEL_PUSH_MATERIALITY" : `INTEL_PUSH_MATERIALITY (now ${pushMateriality})`;
  let s: string;
  if (b.hops === 0 || b.edgeType == null) s = `${ev} events that name a held/watched asset directly are rated noise: lower their extracted magnitude or raise ${push}`;
  else if (b.hops === 2 && (b.edgeType === "narrative" || b.edgeType === "macro_beta")) s = `drop hop-2 ${b.edgeType} edges for ${ev} events`;
  else if (b.hops === 2) s = `limit ${ev} events to 1-hop paths through ${b.edgeType} edges`;
  else s = `lower the ${b.edgeType} edge weight (now ${EDGE_TYPE_WEIGHT[b.edgeType]}) for ${ev} events, or raise ${push}`;
  return `${s}${thin}.${damp}`;
}

export async function feedbackReport(deps: FeedbackDeps): Promise<FeedbackReport> {
  const since = new Date(deps.now().getTime() - REPORT_PERIOD_MS);
  const worst = worstBuckets(await deps.store.feedbackStats(since));
  const report = await deps.store.insertReport({
    kind: "feedback_weekly",
    buckets: worst.map((b) => ({ ...b, suggestion: suggestAdjustment(b, deps.pushMateriality) })),
  });
  return report as FeedbackReport;
}
