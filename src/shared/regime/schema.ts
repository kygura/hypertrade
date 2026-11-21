import { z } from "zod";
import type { HistoryEntry, RegimeThesis } from "./types.js";

// Zod contracts for the regime thesis (docs/REGIME.md). The shapes themselves live in types.ts, the same file
// tradespace carries; these schemas are checked against them at compile time, so the two cannot drift.
//   RegimeDraftSchema   what the model must emit before code cleans it (build.ts clamps, weighs and filters URLs)
//   RegimeThesisSchema  a stored thesis, parsed again on the way out of a store and in the UI
//   RegimeFeedSchema    GET /api/intel/regime

const KINDS = ["onchain_research", "flows", "derivatives", "sentiment", "macro", "analyst", "news", "own_notes"] as const;
const STANCE = z.enum(["risk_off", "defensive", "neutral", "constructive", "risk_on"]);
const CONVICTION = z.enum(["low", "medium", "high"]);
const nullStr = z.string().nullable();
const nullNum = z.number().nullable();

/** Loose on purpose: required where an empty answer would be useless, everything else cleaned by build.ts. */
export const RegimeDraftSchema = z
  .object({
    phase: z.string().min(1),
    stance: STANCE,
    conviction: CONVICTION,
    tldr: z.string().min(1),
    macro: z.string().optional(),
    alts: z.string().optional(),
    key_levels: z.array(z.record(z.unknown())).optional(),
    lines: z.array(z.record(z.unknown())).optional(),
    scenarios: z.array(z.record(z.unknown())).optional(),
    source_reads: z
      .array(z.object({ source: z.string().min(1), name: z.string().optional(), kind: z.string().optional(), lean: z.number(), confidence: z.number().optional(), claim: z.string().min(1) }).passthrough())
      .min(1),
    agreement_notes: z.string().optional(),
    catalysts: z.array(z.record(z.unknown())).optional(),
    narratives: z.array(z.record(z.unknown())).optional(),
    changes: z.array(z.record(z.unknown())).optional(),
    changelog: z.string().min(1),
    source_urls: z.array(z.string()).optional(),
  })
  .passthrough();
export type RegimeDraft = z.infer<typeof RegimeDraftSchema>;

const LEAN = z.union([z.literal(-2), z.literal(-1), z.literal(0), z.literal(1), z.literal(2)]);

export const RegimeThesisSchema: z.ZodType<RegimeThesis> = z.object({
  id: z.string(),
  version: z.number().int(),
  created: z.string(),
  model: z.string(),
  phase: z.string(),
  stance: STANCE,
  conviction: CONVICTION,
  tldr: z.string(),
  macro: z.string(),
  alts: z.string(),
  key_levels: z.array(z.object({ metric: z.string(), level: z.string(), price: nullNum, meaning: z.string(), status: z.string(), sources: z.array(z.string()), as_of: nullStr })),
  lines: z.array(z.object({ kind: z.enum(["bull_confirm", "bear_trigger", "invalidation"]), text: z.string(), price: nullNum })),
  scenarios: z.array(z.object({ name: z.string(), probability: z.number(), path: z.string(), trigger: z.string() })),
  source_reads: z.array(
    z.object({ source: z.string(), name: z.string(), kind: z.enum(KINDS), lean: LEAN, confidence: z.number(), claim: z.string(), url: nullStr, as_of: nullStr, weight: z.number() }),
  ),
  consensus: z.object({
    score: z.number(),
    label: z.enum(["bearish", "lean bearish", "mixed", "lean bullish", "bullish"]),
    dispersion: z.number(),
    agreement: z.enum(["aligned", "split", "contested", "thin"]),
    n: z.number(),
    by_kind: z.record(z.enum(KINDS), z.number()),
    reference: z.object({ source: z.string(), lean: LEAN }).nullable(),
    reference_vs_field: z.enum(["agrees", "differs", "no_reference", "no_field"]),
  }),
  agreement_notes: z.string(),
  catalysts: z.array(z.object({ date: nullStr, event: z.string(), why: z.string(), status: z.enum(["upcoming", "resolved"]) })),
  narratives: z.array(z.object({ name: z.string(), read: z.string() })),
  changes: z.array(z.object({ what: z.string(), from: nullStr, to: z.string(), because: z.string(), sources: z.array(z.string()) })),
  changelog: z.string(),
  sources: z.array(z.object({ title: z.string(), url: z.string() })),
  evidence: z.array(z.string()),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number(), web_searches: z.number() }),
});

export const RegimeHistorySchema: z.ZodType<HistoryEntry> = z.object({
  id: z.string(),
  version: z.number().int(),
  created: z.string(),
  phase: z.string(),
  stance: STANCE,
  conviction: CONVICTION,
  consensus: nullNum,
  changelog: z.string(),
});

export const RegimeFeedSchema = z.object({
  /** False when this deployment has no store that keeps a thesis (no DATABASE_URL, no REGIME_STORE_FILE). */
  persistent: z.boolean(),
  thesis: RegimeThesisSchema.nullable(),
  history: z.array(RegimeHistorySchema),
});
export type RegimeFeed = z.infer<typeof RegimeFeedSchema>;
