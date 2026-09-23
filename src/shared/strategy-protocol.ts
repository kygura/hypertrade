// Zod schemas for the strategy wire contract — hyperion/docs/jev/PROTOCOL.md
// is the single source of truth; field names here mirror it byte for byte.
// Unknown fields are ignored (zod strips them), so the core may add fields
// without breaking this client. Timestamps stay RFC3339 strings.
import { z } from "zod";

// ─── Jev primitives ───

export const ChoiceQuestionSchema = z.object({
  type: z.literal("choice"),
  instructions: z.string(),
  criteria: z.record(z.string(), z.string()),
});

export const ScoreQuestionSchema = z.object({
  type: z.literal("score"),
  instructions: z.string(),
  criteria: z.array(z.string()),
});

export const NoulQuestionSchema = z.object({
  type: z.literal("noul"),
  instructions: z.string(),
});

export const QuestionSchema = z.discriminatedUnion("type", [
  ChoiceQuestionSchema,
  ScoreQuestionSchema,
  NoulQuestionSchema,
]);

// Legend values may be plain strings or objects; clients render `what` when
// it is an object.
export const LegendValueSchema = z.union([
  z.string(),
  z.object({ what: z.string() }).passthrough(),
]);

export const ChoiceAnswerSchema = z.object({
  type: z.literal("choice"),
  choice: z.string(),
  probabilities: z.record(z.string(), z.number()),
  confidence: z.number().optional(),
});

export const ScoreAnswerSchema = z.object({
  type: z.literal("score"),
  score: z.number(),
  probabilities: z.record(z.string(), z.number()),
  legend: z.record(z.string(), LegendValueSchema).optional(),
  confidence: z.number().optional(),
});

export const NoulAnswerSchema = z.object({
  type: z.literal("noul"),
  noul: z.number(),
  confidence: z.number().optional(),
});

export const AnswerSchema = z.discriminatedUnion("type", [
  ChoiceAnswerSchema,
  ScoreAnswerSchema,
  NoulAnswerSchema,
]);

// ─── Core types ───

export const ParamTypeSchema = z.enum(["number", "string", "bool", "enum"]);

export const ParamSpecSchema = z.object({
  key: z.string(),
  type: ParamTypeSchema,
  label: z.string().optional(),
  default: z.unknown().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().optional(),
  options: z.array(z.string()).optional(),
  description: z.string().optional(),
});

export const ManifestSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  description: z.string().default(""),
  venues: z.array(z.string()).default([]),
  cadence: z.string().default(""),
  markets: z.array(z.string()).default([]),
  params: z.array(ParamSpecSchema).default([]),
  questions: z.record(z.string(), QuestionSchema).default({}),
});

export const GovernorModeSchema = z.enum(["manual", "threshold", "auto"]);

export const GovernorSettingsSchema = z.object({
  mode: GovernorModeSchema,
  min_confidence: z.number(),
  max_notional_usd: z.number(),
  max_open_intents: z.number(),
  killed: z.boolean(),
});

// Per-strategy override: same shape, every field optional.
export const GovernorOverrideSchema = GovernorSettingsSchema.partial();

export const StrategyConfigSchema = z.object({
  id: z.string(),
  enabled: z.boolean(),
  venue: z.string(),
  params: z.record(z.string(), z.unknown()).default({}),
  governor: GovernorOverrideSchema.optional(),
});

export const StrategyStatusSchema = z.object({
  manifest: ManifestSchema,
  config: StrategyConfigSchema,
  last_run_at: z.string().nullish(),
  last_decision_id: z.string().nullish(),
  /** Short summary of the newest decision ("open_short ETH", "hold"); absent before the first run. */
  last_action: z.string().nullish(),
  last_error: z.string().nullish(),
  next_run_at: z.string().nullish(),
});

export const IntentActionSchema = z.enum([
  "open_long",
  "open_short",
  "close",
  "scale",
  "rebalance",
  "hold",
]);

export const IntentSchema = z.object({
  id: z.string(),
  strategy_id: z.string(),
  venue: z.string(),
  market: z.string(),
  action: IntentActionSchema,
  size_usd: z.number().nullish(),
  target_weight: z.number().nullish(),
  price_limit: z.number().nullish(),
  reason: z.string().default(""),
  confidence: z.number().nullish(),
});

export const VerdictStatusSchema = z.enum([
  "proposed",
  "approved",
  "rejected",
  "executed",
  "gated",
  "failed",
]);

export const VerdictBySchema = z.enum(["governor", "operator", "gate", "venue"]);

export const VerdictSchema = z.object({
  intent_id: z.string(),
  status: VerdictStatusSchema,
  by: VerdictBySchema,
  reason: z.string().default(""),
  ts: z.string(),
});

export const UsageSchema = z.object({
  input_tokens: z.number().default(0),
  output_tokens: z.number().default(0),
});

export const DecisionRecordSchema = z.object({
  id: z.string(),
  ts: z.string(),
  strategy_id: z.string(),
  venue: z.string(),
  dry_run: z.boolean().default(false),
  state_digest: z.string().default(""),
  state: z.unknown().optional(),
  questions: z.record(z.string(), QuestionSchema).default({}),
  answers: z.record(z.string(), AnswerSchema).default({}),
  intents: z.array(IntentSchema).default([]),
  verdicts: z.array(VerdictSchema).default([]),
  model: z.string().default(""),
  usage: UsageSchema.nullish(),
  latency_ms: z.number().nullish(),
  error: z.string().default(""),
});

export const PositionSchema = z.object({
  market: z.string(),
  size_usd: z.number(),
  entry: z.number().nullish(),
  mark: z.number().nullish(),
  upnl_usd: z.number().nullish(),
});

export const VenueStatusSchema = z.object({
  id: z.string(),
  kind: z.string(),
  chain: z.string().default("none"),
  status: z.string(),
  capabilities: z.array(z.string()).default([]),
  positions: z.array(PositionSchema).default([]),
  /** Set when status is not connected. */
  error: z.string().optional(),
  /** Optional venue-specific facts (evm: network, chain_id, head_block, native_balance, native_symbol, address, protocol). */
  meta: z.record(z.unknown()).optional(),
});

// ─── Envelopes ───

export const ManifestsResponseSchema = z.object({ manifests: z.array(ManifestSchema) });
export const StrategiesResponseSchema = z.object({ strategies: z.array(StrategyStatusSchema) });
export const DecisionsResponseSchema = z.object({ decisions: z.array(DecisionRecordSchema) });
export const VenuesResponseSchema = z.object({ venues: z.array(VenueStatusSchema) });

export const EngineErrorSchema = z.object({
  error: z.string(),
  field: z.string().optional(),
});

// ─── Inferred types ───

export type ChoiceQuestion = z.infer<typeof ChoiceQuestionSchema>;
export type ScoreQuestion = z.infer<typeof ScoreQuestionSchema>;
export type NoulQuestion = z.infer<typeof NoulQuestionSchema>;
export type Question = z.infer<typeof QuestionSchema>;
export type LegendValue = z.infer<typeof LegendValueSchema>;
export type ChoiceAnswer = z.infer<typeof ChoiceAnswerSchema>;
export type ScoreAnswer = z.infer<typeof ScoreAnswerSchema>;
export type NoulAnswer = z.infer<typeof NoulAnswerSchema>;
export type Answer = z.infer<typeof AnswerSchema>;
export type ParamType = z.infer<typeof ParamTypeSchema>;
export type ParamSpec = z.infer<typeof ParamSpecSchema>;
export type Manifest = z.infer<typeof ManifestSchema>;
export type GovernorMode = z.infer<typeof GovernorModeSchema>;
export type GovernorSettings = z.infer<typeof GovernorSettingsSchema>;
export type GovernorOverride = z.infer<typeof GovernorOverrideSchema>;
export type StrategyConfig = z.infer<typeof StrategyConfigSchema>;
export type StrategyStatus = z.infer<typeof StrategyStatusSchema>;
export type IntentAction = z.infer<typeof IntentActionSchema>;
export type Intent = z.infer<typeof IntentSchema>;
export type VerdictStatus = z.infer<typeof VerdictStatusSchema>;
export type Verdict = z.infer<typeof VerdictSchema>;
export type DecisionRecord = z.infer<typeof DecisionRecordSchema>;
export type Position = z.infer<typeof PositionSchema>;
export type VenueStatus = z.infer<typeof VenueStatusSchema>;
export type ManifestsResponse = z.infer<typeof ManifestsResponseSchema>;
export type StrategiesResponse = z.infer<typeof StrategiesResponseSchema>;
export type DecisionsResponse = z.infer<typeof DecisionsResponseSchema>;
export type VenuesResponse = z.infer<typeof VenuesResponseSchema>;
export type EngineError = z.infer<typeof EngineErrorSchema>;

/** Text to render for a legend entry: `what` when the value is an object. */
export function legendText(v: LegendValue | undefined): string {
  if (v == null) return "";
  return typeof v === "string" ? v : v.what;
}
