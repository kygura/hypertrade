import { z } from "zod";

// The one setup shape (docs/research/candidates-redesign.md § B.1). A setup is
// a conditional plan for a human, not an order: entry zone, invalidation with
// its reason, 1–3 targets, R computed by code. Persisted in the setups store
// (src/server/setups/store.ts) and exported to data/setups/ledger.json.

const Price = z.number().finite().positive();

/** Setup definitions of the candidate catalogue. A setup with `setup_id: null` came from a model proposal, not a definition. */
export const SETUP_IDS = ["funding_fade", "post_liquidation_reclaim", "sector_continuation", "negative_funding_build", "htf_pullback", "range_breakout", "failed_breakout"] as const;
export const SetupIdSchema = z.enum(SETUP_IDS);
export type SetupId = z.infer<typeof SetupIdSchema>;

export const DirectionSchema = z.enum(["long", "short"]);
/** Swing only: daily-to-weekly plans that expire within GATE.maxDays.swing (src/server/routine/gate.ts). */
export const HorizonSchema = z.enum(["swing"]);
export const SetupStatusSchema = z.enum(["watching", "triggered", "invalidated", "target_hit", "expired", "cancelled"]);
export const OPEN_STATUSES = ["watching", "triggered"] as const satisfies readonly z.infer<typeof SetupStatusSchema>[];
/**
 * Who built the levels: "code" = a catalogue definition, "menu" = the model picked them from the code-computed level
 * menu of the board scan (src/server/routine/scan.ts), "model" = free prices from an LLM proposal the gate accepted.
 */
export const LevelsSourceSchema = z.enum(["code", "menu", "model"]);
/** The bar the trigger is read on; it sets the expiry (src/server/routine/scan.ts EXPIRY_DAYS). */
export const SetupTimeframeSchema = z.enum(["4h", "1d", "1w"]);

export const SetupSchema = z.object({
  id: z.string(),
  /** Older ledgers lack it; they were all model proposals. */
  setup_id: SetupIdSchema.nullable().default(null),
  levels_source: LevelsSourceSchema.default("model"),
  asset: z.string(),
  direction: DirectionSchema,
  horizon: HorizonSchema,
  /** Older ledgers lack it. */
  timeframe: SetupTimeframeSchema.nullable().default(null),
  thesis: z.string(),
  regime_alignment: z.enum(["with", "counter"]),
  trigger: z.string(),
  entry: z.object({ low: Price, high: Price }),
  invalidation: Price,
  invalidation_reason: z.string(),
  targets: z.array(Price).min(1).max(3),
  rr: z.number(),
  conviction: z.enum(["low", "medium", "high"]),
  evidence: z.array(z.string()),
  status: SetupStatusSchema,
  status_note: z.string().nullable(),
  r_result: z.number().nullable(),
  /** When the entry zone first traded; null if it never did. Older ledgers lack it. */
  triggered_at: z.string().nullable().default(null),
  created_at: z.string(),
  updated_at: z.string(),
  expires_at: z.string(),
});
export type Setup = z.infer<typeof SetupSchema>;

export const isOpenSetup = (s: Pick<Setup, "status">) => (OPEN_STATUSES as readonly string[]).includes(s.status);

export const LedgerStatsSchema = z.object({
  closed_90d: z.number(),
  triggered_90d: z.number(),
  hit_rate: z.number().nullable(),
  avg_r: z.number().nullable(),
});
export const LedgerSchema = z.object({
  updated_at: z.string(),
  open: z.array(SetupSchema),
  closed: z.array(SetupSchema),
  stats: LedgerStatsSchema,
});
export type Ledger = z.infer<typeof LedgerSchema>;
export type LedgerStats = z.infer<typeof LedgerStatsSchema>;
