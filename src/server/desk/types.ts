import { z } from "zod";

// Desk wire types (docs/SPEC.md "Desk"). The agents propose through these
// schemas; the governor (governor.ts) is the only thing that turns a
// proposal into an order, and it never trusts the model's arithmetic: size,
// risk in dollars and reward:risk are computed here from live marks.

const SideSchema = z.enum(["long", "short"]);
export type Side = z.infer<typeof SideSchema>;

const ConfidenceSchema = z.enum(["low", "medium", "high"]);
export type Confidence = z.infer<typeof ConfidenceSchema>;

const price = z.number().finite().positive();

/** What an agent submits through propose_trade. */
export const TradeProposalSchema = z
  .object({
    coin: z.string().trim().min(1).max(20),
    side: SideSchema,
    setup: z.string().trim().min(3).max(80),
    thesis: z.string().trim().min(20).max(2000),
    horizon: z.enum(["intraday", "swing", "position"]),
    confidence: ConfidenceSchema,
    stop: price,
    target: price,
    /** Percent of equity lost if the stop fills (0.05–2). */
    riskPct: z.number().min(0.05).max(2),
    /** Worst acceptable entry: the governor rejects when the mark is already past it. */
    entryLimit: price.optional(),
    /** Propr venue only: the cross leverage for this trade, chosen by conviction: 1x for exposure that is hard to
     * liquidate, up to 10x for high conviction, capped per coin (10x BTC/ETH/SOL, 2x others). It is also the coin's
     * notional ceiling for this trade; risk still comes from the stop. Omit it to use the desk's default. */
    leverage: z.number().min(1).max(10).optional(),
    invalidation: z.string().trim().min(5).max(500),
    evidence: z
      .array(z.object({ source: z.string().trim().min(1).max(80), point: z.string().trim().min(3).max(400) }))
      .min(2)
      .max(12),
  })
  .strict();
export type TradeProposal = z.infer<typeof TradeProposalSchema>;

/** The fields the governor's risk checks need from any order (evaluateRisk). */
const RiskOrderSchema = z
  .object({
    coin: z.string().trim().min(1).max(20),
    side: SideSchema,
    stop: price,
    /** Optional: without it the reward:risk check is skipped, with a warning. */
    target: price.optional(),
    riskPct: z.number().min(0.05).max(2),
    entryLimit: price.optional(),
    /** The trade's leverage. On the Propr venue: the cross leverage set before the entry and the coin's notional ceiling. */
    leverage: z.number().positive().max(50).optional(),
    /** The signal's conviction. On the Propr venue it picks the leverage when the order sets none (PROPR_LEVERAGE_BY_CONFIDENCE). Never sizes. */
    confidence: ConfidenceSchema.optional(),
  })
  .strict();
export type RiskOrder = z.infer<typeof RiskOrderSchema>;

/**
 * An order the operator confirms through the copilot (preview, then submit),
 * or a platform ticket. Sized by notionalUsd, else riskPct, else leverage ×
 * equity; the governor clips it either way. `leverage` sizes the order (×
 * equity) only when neither is given; on the Propr venue it is always the
 * cross leverage the trade runs at.
 */
export const OperatorOrderSchema = RiskOrderSchema.extend({
  riskPct: RiskOrderSchema.shape.riskPct.optional(),
  leverage: z.number().positive().max(50).optional(),
  notionalUsd: z.number().finite().positive().optional(),
  source: z.literal("copilot"),
})
  .strict()
  .refine((o) => o.riskPct != null || o.notionalUsd != null || o.leverage != null, { message: "give riskPct, notionalUsd or leverage" });
export type OperatorOrder = z.infer<typeof OperatorOrderSchema>;
/** An operator order as recorded: the order as confirmed plus the risk percent the governor sized it at. */
export type OperatorOrderRecord = OperatorOrder & { resolvedRiskPct: number };
/** An entry placed from a written plan (DeskService.submitPlan): the risk order the governor checked, the plan's rungs and journal id. */
export type PlanOrderRecord = RiskOrder & { source: "plan"; planId: string; rungs: Array<{ px: number; size: number }>; resolvedRiskPct: number };

/** What an agent submits through propose_exit. */
export const ExitProposalSchema = z
  .object({
    coin: z.string().trim().min(1).max(20),
    fraction: z.number().gt(0).max(1),
    reason: z.string().trim().min(5).max(800),
  })
  .strict();
export type ExitProposal = z.infer<typeof ExitProposalSchema>;

export interface Sizing {
  markPx: number;
  size: number;
  notionalUsd: number;
  riskUsd: number;
  stopDistPct: number;
  /** Null when the order has no target (reward:risk not checked). */
  rr: number | null;
  feeUsd: number;
  grossLeverageAfter: number;
}

export interface Verdict {
  approved: boolean;
  /** Blocking reasons; empty when approved. */
  reasons: string[];
  warnings: string[];
  sizing?: Sizing;
  equityUsd: number;
  checkedAt: string;
}

export interface Position {
  coin: string;
  side: Side;
  size: number;
  entryPx: number;
  markPx: number;
  stopPx: number | null;
  tpPx: number | null;
  unrealizedPnl: number;
  notionalUsd: number;
}

export interface AccountState {
  venue: string;
  equityUsd: number;
  /** Realized + unrealized PnL since 00:00 UTC, in USD. */
  dayPnlUsd: number;
  positions: Position[];
  /** False when the account could not be read (no address configured, upstream error). */
  available: boolean;
  note?: string;
}

export type ProposalStatus = "pending" | "rejected" | "blocked" | "executed" | "failed" | "expired";

export interface ProposalRecord {
  id: string;
  runId: string | null;
  kind: "open" | "exit";
  status: ProposalStatus;
  venue: string;
  proposal: TradeProposal | ExitProposal | OperatorOrderRecord | PlanOrderRecord;
  verdict: Verdict;
  execution: unknown;
  decidedBy: string | null;
  decidedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export type AlertLevel = "info" | "warn" | "critical";

/** Everything a desk run streams; persisted to desk_events and sent over SSE. */
export type DeskEvent =
  | { type: "run_start"; runId: string; kind: "ask" | "cycle"; question: string }
  | { type: "agent_start"; agent: string; role: string; parent: string | null; task: string; model: string }
  | { type: "agent_done"; agent: string; stop: string; rounds: number; report?: string }
  | { type: "text"; agent: string; delta: string }
  | { type: "reasoning"; agent: string; delta: string }
  | { type: "tool_call"; agent: string; id: string; name: string; input: unknown; server: boolean }
  | { type: "tool_result"; agent: string; id: string; name: string; ok: boolean; summary: string }
  | { type: "citations"; citations: Array<{ url: string; title: string | null }> }
  | { type: "proposal"; agent: string; id: string; kind: "open" | "exit"; status: ProposalStatus; coin: string; summary: string }
  | { type: "alert"; agent: string; level: AlertLevel; title: string }
  | { type: "error"; agent: string; error: string }
  | { type: "done"; runId: string; stop: string; usage: { input_tokens: number; output_tokens: number }; costUsd: number | null };
