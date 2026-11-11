import { z } from "zod";
import { AssetSchema } from "./intel.js";

// Agent watch contract (docs/SPEC.md § Moves): the daily triage queue and the records an investigation agent
// writes. Code computes every number in `inputs` and `grade`; the model proposes `claim`, `layer`, `direction`
// and one price (the falsifier level), which code checks against the mark. Server and UI both import this file.

const Iso = z.string().datetime({ offset: true });
const Num = z.number().finite();
const Pos = z.number().finite().positive();
const Count = z.number().int().nonnegative();
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "invalid day");

export const MOVE_WINDOWS = ["4h", "24h", "72h"] as const;
export const MoveWindowSchema = z.enum(MOVE_WINDOWS);
export type MoveWindow = z.infer<typeof MoveWindowSchema>;
export const WINDOW_HOURS: Record<MoveWindow, 4 | 24 | 72> = { "4h": 4, "24h": 24, "72h": 72 };

/** The layer a record blames for the move. The model's proposal, shown as a hypothesis beside code's attribution. */
export const AGENT_LAYERS = ["beta", "forced_flow", "microstructure", "narrative", "unexplained"] as const;
export const AgentLayerSchema = z.enum(AGENT_LAYERS);
export type AgentLayer = z.infer<typeof AgentLayerSchema>;

/**
 * `open`: written, waiting for its horizon. `falsified`: price crossed the falsifier level before the horizon.
 * `graded`: horizon reached. `no_cause`: the agent found no public cause (counted, never graded). `failed`: the
 * model call or its validation failed. `capped`: a daily cap was reached before the provider call.
 */
export const AGENT_RECORD_STATUSES = ["open", "falsified", "graded", "no_cause", "failed", "capped"] as const;
export const AgentRecordStatusSchema = z.enum(AGENT_RECORD_STATUSES);
export type AgentRecordStatus = z.infer<typeof AgentRecordStatusSchema>;

export const AgentSourceSchema = z.object({
  url: z.string().url(),
  /** Publication time when the provider's citation carries one. */
  ts: Iso.nullable(),
  title: z.string().max(300),
  /** True only when the provider's citations print this source; a model-typed URL alone is false. */
  observed: z.boolean(),
});
export type AgentSource = z.infer<typeof AgentSourceSchema>;

export const AgentFalsifierSchema = z.object({
  level: Pos,
  /** The record is falsified when price trades on this side of `level`. */
  side: z.enum(["below", "above"]),
  text: z.string().max(200),
});
export type AgentFalsifier = z.infer<typeof AgentFalsifierSchema>;

export const AgentGradeSchema = z.object({
  /** Hours from creation to the grade (the horizon, or earlier when falsified). */
  atHours: Num,
  px: Pos,
  btcPx: Pos,
  /** 100 · dirSign · (ln(px/mark0) − ln(btc/btc0)): log-% vs BTC, signed by the record's direction. */
  relPct: Num,
  hit: z.boolean(),
  falsifiedAt: Iso.nullable(),
});
export type AgentGrade = z.infer<typeof AgentGradeSchema>;

export const AgentRecordSchema = z.object({
  id: z.string().min(1),
  coin: AssetSchema,
  createdAt: Iso,
  trigger: z.enum(["triage", "manual"]),
  /** Code-written snapshot of what the agent was shown. */
  inputs: z.object({
    window: MoveWindowSchema,
    residualPct: Num.nullable(),
    residualZ: Num.nullable(),
    totalPct: Num.nullable(),
    markAtCreate: Pos,
    btcAtCreate: Pos,
    asOf: Iso,
  }),
  claim: z.string().max(400),
  assets: z.array(AssetSchema).max(8),
  direction: z.enum(["long", "short"]).nullable(),
  horizonHours: z.union([z.literal(4), z.literal(24), z.literal(72)]),
  layer: AgentLayerSchema,
  falsifier: AgentFalsifierSchema.nullable(),
  sources: z.array(AgentSourceSchema).max(8),
  status: AgentRecordStatusSchema,
  grade: AgentGradeSchema.nullable(),
  model: z.string().nullable(),
  promptVersion: z.string().min(1),
  /** Lines the number validator dropped from the model's output. */
  dropped: Count,
  /** Why a `failed` or `capped` record has no content (no provider, cap reached, schema miss); null otherwise. */
  error: z.string().max(300).nullable().optional(),
});
export type AgentRecord = z.infer<typeof AgentRecordSchema>;

export const TriageItemSchema = z.object({
  id: z.string().min(1),
  /** UTC day the item was surfaced on; one item per coin per day. */
  day: Day,
  coin: AssetSchema,
  /** Facts only, e.g. `residual +6.2% · z 3.1 · 24h · no news in window`. */
  reason: z.string().min(1).max(200),
  score: Num,
  /** |residual z| when surfaced; null for a checklist-only item. */
  residualZ: Num.nullable(),
  surfacedAt: Iso,
  dismissedAt: Iso.nullable(),
  recordId: z.string().nullable(),
});
export type TriageItem = z.infer<typeof TriageItemSchema>;

export const TriageResponseSchema = z.object({
  state: z.enum(["ok", "unavailable"]),
  reason: z.string().nullable(),
  day: Day,
  /** MOVES_TRIAGE_DAILY: items surfaced per UTC day at most. */
  budget: Count,
  surfaced: Count,
  /** Candidates that crossed the bar after the budget was spent; counted, not listed. */
  overBudget: Count,
  /** Coins scanned in the latest run. */
  watched: Count,
  /** Agent investigations run today and the daily cap (MOVES_AGENT_DAILY). */
  agentRuns: Count,
  agentCap: Count,
  /** Null when an investigation can run; otherwise why not (no provider, cap reached). */
  agentBlockedReason: z.string().nullable(),
  items: z.array(TriageItemSchema.extend({ record: AgentRecordSchema.nullable() })),
});
export type TriageResponse = z.infer<typeof TriageResponseSchema>;

export const AgentRecordsResponseSchema = z.object({ records: z.array(AgentRecordSchema) });
export type AgentRecordsResponse = z.infer<typeof AgentRecordsResponseSchema>;

/** groupStats over graded records: null numbers under 5 clusters, as the ledger. */
export const AgentStatsRowSchema = z.object({
  key: z.string().min(1),
  n: Count,
  clusters: Count,
  meanRelPct: Num.nullable(),
  ci95: z.tuple([Num, Num]).nullable(),
  hitRate: Num.nullable(),
});
export type AgentStatsRow = z.infer<typeof AgentStatsRowSchema>;

export const AgentStatsResponseSchema = z.object({
  /** All records ever written, graded or not. */
  total: Count,
  graded: Count,
  noCause: Count,
  byHorizon: z.array(AgentStatsRowSchema),
  byLayer: z.array(AgentStatsRowSchema),
});
export type AgentStatsResponse = z.infer<typeof AgentStatsResponseSchema>;
