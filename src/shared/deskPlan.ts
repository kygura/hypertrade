import { z } from "zod";

// Desk plans (the "calm desk" rules): an entry is placed only from a written plan (coin, side, a ladder of price
// levels with a size each, a stop and a target), checked by src/server/desk/plan.ts checkPlan and journaled whether
// or not it was placed. Stop-outs lock new entries (src/server/desk/cooldown.ts); the lock state lives in the desk's
// key/value table and is parsed with CooldownStateSchema on the way out.
//
// Routes (src/server/routes/desk.ts):
//   POST /desk/plans/check  DeskPlanCheckRequest  → PlanCheck (nothing saved)
//   POST /desk/plans        DeskPlanSubmitRequest → DeskPlanSubmitResponse
//   GET  /desk/plans?limit  → DeskPlanListResponse (newest first)
//   GET  /desk/cooldown     → DeskCooldownResponse

const px = z.number().finite().positive();

export const PlanRungSchema = z.object({ px, size: z.number().finite().positive() }).strict();
export type PlanRung = z.infer<typeof PlanRungSchema>;

/**
 * What the operator writes. stopPx and targetPx are nullable so a form can send an unfinished plan to
 * /plans/check and show the block; checkPlan always blocks a plan without either.
 */
export const DeskPlanInputSchema = z
  .object({
    coin: z.string().trim().min(1).max(20),
    side: z.enum(["long", "short"]),
    rungs: z.array(PlanRungSchema).min(1).max(20),
    stopPx: px.nullable(),
    targetPx: px.nullable(),
    note: z.string().trim().max(1000).optional(),
  })
  .strict();
export type DeskPlanInput = z.infer<typeof DeskPlanInputSchema>;

/**
 * The plan's numbers. No fees. Null where an input is missing (no stop, no target, no equity).
 *
 * - avgEntryPx: size-weighted average of the rungs (every rung filled).
 * - lossAtStopUsd: Σ size × (rung → stop distance), every rung filled; lossAtStopPct is that over equity.
 * - rrFull: (target − avg) / (avg − stop), every rung filled.
 * - rrTopOnly: the same for the top rung alone. The top rung is the first to fill as price moves from the mark
 *   toward the stop: the highest-priced rung of a long, the lowest-priced rung of a short (topRungPx).
 * - dailyLimitUsedPct: (loss already taken today + lossAtStopUsd) / today's loss limit (DESK_DAILY_LOSS_PCT of
 *   equity). "Already taken" is the desk's day PnL since 00:00 UTC when negative (realized and unrealized).
 * - drawdownUsedPct: lossAtStopUsd / the account's max drawdown (DESK_MAX_DRAWDOWN_PCT, or the Propr firm's
 *   PROPR_MAX_DRAWDOWN_PCT, of the drawdown base: Propr's starting balance when configured, else equity).
 */
export const PlanMetricsSchema = z.object({
  totalSize: z.number(),
  notionalUsd: z.number(),
  avgEntryPx: z.number(),
  topRungPx: z.number(),
  lossAtStopUsd: z.number().nullable(),
  lossAtStopPct: z.number().nullable(),
  rrFull: z.number().nullable(),
  rrTopOnly: z.number().nullable(),
  dailyLimitUsedPct: z.number().nullable(),
  drawdownUsedPct: z.number().nullable(),
  equityUsd: z.number(),
  markPx: z.number().nullable(),
});
export type PlanMetrics = z.infer<typeof PlanMetricsSchema>;

/** A plan is submittable only with no blockers. */
export const PlanCheckSchema = z.object({
  metrics: PlanMetricsSchema,
  blockers: z.array(z.string()),
  warnings: z.array(z.string()),
});
export type PlanCheck = z.infer<typeof PlanCheckSchema>;

/** What became of a placed plan: the desk proposal that carried it and its outcome. */
export const PlanPlacementSchema = z.object({
  proposalId: z.string(),
  status: z.enum(["pending", "rejected", "blocked", "executed", "failed", "expired"]),
  error: z.string().nullable(),
  dryRun: z.boolean(),
  note: z.string().nullable(),
});
export type PlanPlacement = z.infer<typeof PlanPlacementSchema>;

/** One journal entry. source "copilot": an order confirmed through the /order copilot, journaled as a one-rung plan at the mark. */
export const DeskPlanRecordSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  source: z.enum(["plan", "copilot"]),
  venue: z.string(),
  input: DeskPlanInputSchema,
  metrics: PlanMetricsSchema,
  blockers: z.array(z.string()),
  warnings: z.array(z.string()),
  /** True when the venue took the order (the proposal executed). */
  placed: z.boolean(),
  /** Null when placement was not asked for or was blocked before reaching the venue. */
  placement: PlanPlacementSchema.nullable(),
});
export type DeskPlanRecord = z.infer<typeof DeskPlanRecordSchema>;

export const DeskPlanCheckRequestSchema = z.object({ plan: DeskPlanInputSchema }).strict();
export const DeskPlanSubmitRequestSchema = z.object({ plan: DeskPlanInputSchema, place: z.boolean() }).strict();
export type DeskPlanSubmitRequest = z.infer<typeof DeskPlanSubmitRequestSchema>;

export const DeskPlanSubmitResponseSchema = z.object({ record: DeskPlanRecordSchema, check: PlanCheckSchema, placed: z.boolean() });
export type DeskPlanSubmitResponse = z.infer<typeof DeskPlanSubmitResponseSchema>;
export const DeskPlanListResponseSchema = z.object({ plans: z.array(DeskPlanRecordSchema) });

// ---------------------------------------------------------------- cooldown

/** The loss behind a stop-out: the plan when the desk can tie the position to one, the settled fill otherwise. */
export const StopOutRefSchema = z.object({
  /** "paper": the paper book settled the stop; "watch": a live position vanished on a tick whose range touched its stop. */
  source: z.enum(["paper", "watch"]),
  proposalId: z.string().nullable(),
  planId: z.string().nullable(),
  fill: z
    .object({ side: z.enum(["long", "short"]), size: z.number(), px: z.number(), pnl: z.number().nullable() })
    .nullable(),
});
export type StopOutRef = z.infer<typeof StopOutRefSchema>;

export const StopOutSchema = z.object({ coin: z.string(), at: z.string(), ref: StopOutRefSchema });
export type StopOut = z.infer<typeof StopOutSchema>;

/** Stored under the desk_state key "cooldown". */
export const CooldownStateSchema = z.object({ stopOuts: z.array(StopOutSchema) });
export type CooldownState = z.infer<typeof CooldownStateSchema>;

export const CoinLockSchema = z.object({ coin: z.string(), until: z.string(), stopOutAt: z.string(), ref: StopOutRefSchema });
export type CoinLock = z.infer<typeof CoinLockSchema>;

export const ActiveLocksSchema = z.object({
  coins: z.array(CoinLockSchema),
  /** Every new entry is locked until the next 00:00 UTC (the desk's day boundary). */
  all: z.object({ until: z.string(), reason: z.string() }).nullable(),
  stopOutsToday: z.number().int(),
});
export type ActiveLocks = z.infer<typeof ActiveLocksSchema>;

/** GET /desk/cooldown: each lock with its journal entry (the plan record when known, else null and the ref's fill). */
export const DeskCooldownResponseSchema = ActiveLocksSchema.extend({
  coins: z.array(CoinLockSchema.extend({ plan: DeskPlanRecordSchema.nullable() })),
});
export type DeskCooldownResponse = z.infer<typeof DeskCooldownResponseSchema>;
