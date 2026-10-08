import { z } from "zod";

// Desk wire types (SPEC.md "Desk"). The agents propose through these
// schemas; the governor (governor.ts) is the only thing that turns a
// proposal into an order, and it never trusts the model's arithmetic: size,
// risk in dollars and reward:risk are computed here from live marks.

export const SideSchema = z.enum(["long", "short"]);
export type Side = z.infer<typeof SideSchema>;

export const ConfidenceSchema = z.enum(["low", "medium", "high"]);
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
    invalidation: z.string().trim().min(5).max(500),
    evidence: z
      .array(z.object({ source: z.string().trim().min(1).max(80), point: z.string().trim().min(3).max(400) }))
      .min(2)
      .max(12),
  })
  .strict();
export type TradeProposal = z.infer<typeof TradeProposalSchema>;

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
  rr: number;
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
  proposal: TradeProposal | ExitProposal;
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
