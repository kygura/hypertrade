import { z, type ZodTypeAny } from "zod";
import type { ToolSpec } from "../llm/provider.js";
import { MarketStateDataSchema, SectorsDataSchema } from "../../shared/schemas.js";
import { DirectionSchema, HorizonSchema, SetupIdSchema, SetupTimeframeSchema } from "../../shared/setups.js";
import { LEVEL_KEYS } from "./board.js";

// Data shapes of the fallback routine (docs/fallback-routine.md § Data
// shapes). Persisted shapes (Setup, Ledger, HtfView) are what lives in
// data/setups/*.json; the *Draft / *Output shapes are what the model may
// emit. Fields the code owns (ids, status, rr, prices, alignment, expiry,
// timestamps) never appear in a model shape, so the model cannot set them.

const Price = z.number().finite().positive();

// Setup, Ledger and their parts live in src/shared/setups.ts (one shape for every
// generator); re-exported here so routine modules keep importing from one place.
export { DirectionSchema, SetupStatusSchema, SetupSchema, LedgerStatsSchema, LedgerSchema, type Setup, type Ledger, type LedgerStats } from "../../shared/setups.js";

export const BiasSchema = z.object({
  asset: z.string().min(1).max(24),
  bias: z.enum(["long", "short", "neutral"]),
  levels: z.array(z.object({ label: z.string().min(1).max(80), price: Price })).max(6),
  note: z.string().max(400),
});

/** The operator's stance file (data/setups/htf.json). Optional: while it is valid, stance stand_aside blocks every new setup. */
export const HtfViewDraftSchema = z.object({
  regime: z.enum(["risk_on", "neutral", "risk_off"]),
  stance: z.enum(["trend_long", "range", "trend_short", "stand_aside"]),
  thesis: z.string().min(1).max(1500),
  biases: z.array(BiasSchema).max(4),
  what_changes_it: z.array(z.string().min(1).max(300)).min(1).max(5),
});
export const HtfViewSchema = HtfViewDraftSchema.extend({
  generated_at: z.string(),
  valid_until: z.string(),
  hl_cycles_state: z.string().nullable(),
});
export type HtfView = z.infer<typeof HtfViewSchema>;

/** A priced proposal: what the gate checks. Built by code from a SetupDraft (scan.ts), never emitted by the model. */
export const SetupProposalSchema = z.object({
  asset: z.string().min(1).max(24),
  direction: DirectionSchema,
  horizon: HorizonSchema,
  thesis: z.string().min(1).max(800),
  regime_alignment: z.enum(["with", "counter"]),
  trigger: z.string().min(1).max(300),
  entry: z.object({ low: Price, high: Price }),
  invalidation: Price,
  invalidation_reason: z.string().min(1).max(300),
  targets: z.array(Price).min(1).max(3),
  conviction: z.enum(["low", "medium", "high"]),
  evidence: z.array(z.string().max(120)).min(1).max(8),
  expires_at: z.string(),
});
export type SetupProposal = z.infer<typeof SetupProposalSchema>;

/** Commonplace imbalances the scan names. "other" needs its note to say what it is. */
export const IMBALANCE_KINDS = [
  "crowded_longs",
  "crowded_shorts",
  "shorts_pressing",
  "short_covering",
  "long_liquidation",
  "absorption",
  "venue_divergence",
  "relative_strength",
  "relative_weakness",
  "compression",
  "trend_exhaustion",
  "other",
] as const;
export const ImbalanceKindSchema = z.enum(IMBALANCE_KINDS);

const LevelRefSchema = z.object({
  level: z.enum(LEVEL_KEYS).describe("A key from this market's level menu"),
  atr: z.number().min(-3).max(3).optional().describe("ATR multiples added to the level, signed; the 4h ATR for a 4h setup, else the 1d ATR"),
});
const TARGET_KEYS = [...LEVEL_KEYS, "R"] as const;
const TargetRefSchema = z
  .object({
    level: z.enum(TARGET_KEYS).describe('A level key, or "R" for a multiple of the risk measured from the entry midpoint'),
    atr: z.number().min(-3).max(3).optional().describe("With a level key: ATR multiples added, signed"),
    r: z.number().min(1).max(10).optional().describe('With level "R": the multiple, e.g. 2 for 2R'),
  })
  .superRefine((t, ctx) => {
    if (t.level === "R" && t.r === undefined) ctx.addIssue({ code: "custom", path: ["r"], message: 'level "R" needs r' });
  });

/** A setup as the model writes it: structure and reasons, with every price a reference into the level menu. */
export const SetupDraftSchema = z.object({
  asset: z.string().min(1).max(24).describe("Board symbol, case-sensitive"),
  direction: DirectionSchema,
  template: SetupIdSchema.nullable().describe("The tripwire template this writes up, or null for an imbalance no template covers"),
  timeframe: SetupTimeframeSchema.describe("The bar the trigger is read on; code sets the expiry from it (4h: 3 days, 1d: 7, 1w: 10)"),
  imbalance: ImbalanceKindSchema,
  thesis: z.string().min(1).max(800).describe("Why, with board numbers, and one clause on what the other side sees"),
  trigger: z.string().min(1).max(300).describe("The checkable condition a human would watch for, on the timeframe's bar"),
  entry: z.object({ low: LevelRefSchema, high: LevelRefSchema }),
  invalidation: LevelRefSchema,
  invalidation_reason: z.string().min(1).max(300).describe("Why losing that level breaks the thesis"),
  targets: z.array(TargetRefSchema).min(1).max(3).describe("In profit order; the first must sit at least 2R away"),
  conviction: z.enum(["low", "medium", "high"]),
  evidence: z.array(z.string().max(120)).min(1).max(8).describe("Board keys, e.g. HYPE.pos.fundingAnnPct, HYPE.tf.1d.rangePos"),
});
export type SetupDraft = z.infer<typeof SetupDraftSchema>;

export const WatchItemSchema = z.object({
  asset: z.string().min(1).max(24),
  kind: ImbalanceKindSchema,
  skew: z.enum(["up", "down", "either"]).describe("Which way the imbalance would likely resolve, if it does"),
  timeframe: SetupTimeframeSchema,
  note: z.string().min(1).max(300).describe("What the board shows, with its numbers, including the signals that only lean"),
  arms: z.string().min(1).max(200).describe("The checkable condition that would turn this into a setup"),
  evidence: z.array(z.string().max(120)).min(1).max(6),
});
export type WatchItem = z.infer<typeof WatchItemSchema>;

export const ScanOutputSchema = z.object({
  read: z.string().min(1).max(400).describe("One or two sentences: where the board leans and where the largest imbalance sits"),
  watchlist: z.array(WatchItemSchema).max(6).describe("Most imbalanced markets first"),
  setups: z.array(SetupDraftSchema).max(3).describe("Conditional plans where an imbalance meets a level; [] when none has both"),
  passes: z
    .array(z.object({ asset: z.string(), template: SetupIdSchema, direction: DirectionSchema, reason: z.string().min(1).max(200) }))
    .max(20)
    .describe("Every tripwire hit not written up as a setup, with why"),
  cancel: z.array(z.object({ id: z.string(), reason: z.string().min(1).max(300) })).max(5).describe("Open setups whose premise broke before price did"),
  brief: z.string().min(1).max(1200).describe("Short, delta-first text for a human"),
});
export type ScanOutput = z.infer<typeof ScanOutputSchema>;

export const DOMAINS = ["macro", "equities", "crypto", "tech", "geopolitics"] as const;
export const DISCLAIMER = "Not financial advice. Market intelligence only — a reasoned read of public data, not a recommendation to buy or sell anything.";

// Model-side MarketState/Sectors: the app's schemas minus generated_at (code
// sets it), with the vocabulary ROUTINE.md §4.1–4.3 asks for made strict.
const SignalDraft = z.object({ label: z.string().min(1), value: z.string().min(1), direction: z.enum(["up", "down", "flat"]) });
const MarketStateDraftSchema = z.object({
  headline: z.string().min(1).max(300).describe("The single most important change since the last run, with its number"),
  tldr: z.string().min(1).max(900),
  domains: z.array(z.object({ domain: z.enum(DOMAINS), summary: z.string().min(1), signals: z.array(SignalDraft) })).length(5).describe("macro, equities, crypto, tech, geopolitics, in that order"),
  thesis: z.object({ observe: z.string().min(1), infer: z.string().min(1), forecast: z.string().min(1) }),
  risks: z.array(z.string().min(1).max(300)).min(2).max(4).describe("Checkable: metric + threshold + direction"),
});
const SectorsDraftSchema = z.object({
  sectors: z
    .array(
      z.object({
        id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "kebab-case"),
        label: z.string().min(1),
        mindshare_score: z.number().min(0).max(1),
        momentum: z.number().min(-1).max(1),
        rationale: z.string().min(1),
        tokens: z.array(z.string()),
        sources: z.array(z.string()),
      }),
    )
    .min(1),
  rotations: z.array(z.object({ from: z.string(), to: z.string(), confidence: z.number().min(0).max(1), trigger: z.string().min(1), note: z.string() })),
});
export const DailyOutputSchema = z
  .object({
    marketstate: MarketStateDraftSchema,
    sectors: SectorsDraftSchema,
    scorecard: z
      .array(z.object({ call: z.string().max(300), grade: z.enum(["hit", "missed", "pending", "uncheckable"]), evidence: z.string().max(300) }))
      .max(10)
      .describe("Grades of the previous run's forecast, risks and rotation triggers"),
  })
  .superRefine((o, ctx) => {
    o.marketstate.domains.forEach((d, i) => {
      if (d.domain !== DOMAINS[i]) ctx.addIssue({ code: "custom", path: ["marketstate", "domains", i, "domain"], message: `expected ${DOMAINS[i]}` });
    });
    const ids = new Set(o.sectors.sectors.map((s) => s.id));
    o.sectors.rotations.forEach((r, i) => {
      if (!ids.has(r.from) || !ids.has(r.to)) ctx.addIssue({ code: "custom", path: ["sectors", "rotations", i], message: "from/to must be sector ids listed above" });
    });
  });
export type DailyOutput = z.infer<typeof DailyOutputSchema>;
export { MarketStateDataSchema, SectorsDataSchema };

/**
 * JSON Schema for the `emit` tool, derived from a zod schema so the two can
 * never drift. Covers the subset this module uses (object, array, string,
 * number, boolean, enum, nullable, optional, effects); anything else throws
 * at startup rather than emitting a wrong schema.
 */
export function toJsonSchema(schema: ZodTypeAny): ToolSpec["input_schema"] {
  const out = convert(schema);
  if (out.type !== "object") throw new Error("emit schema must be an object");
  return out as ToolSpec["input_schema"];
}

function convert(s: ZodTypeAny): Record<string, unknown> {
  const def = s._def as { typeName: string; description?: string } & Record<string, unknown>;
  const withDesc = (o: Record<string, unknown>) => (def.description ? { ...o, description: def.description } : o);
  switch (def.typeName) {
    case "ZodEffects":
      return withDesc(convert(def.schema as ZodTypeAny));
    case "ZodOptional":
      return withDesc(convert(def.innerType as ZodTypeAny));
    case "ZodNullable": {
      const inner = convert(def.innerType as ZodTypeAny);
      return withDesc({ anyOf: [inner, { type: "null" }] });
    }
    case "ZodString":
      return withDesc({ type: "string" });
    case "ZodNumber":
      return withDesc({ type: "number" });
    case "ZodBoolean":
      return withDesc({ type: "boolean" });
    case "ZodEnum":
      return withDesc({ type: "string", enum: def.values });
    case "ZodArray":
      return withDesc({ type: "array", items: convert(def.type as ZodTypeAny) });
    case "ZodObject": {
      const shape = (s as z.AnyZodObject).shape as Record<string, ZodTypeAny>;
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [k, v] of Object.entries(shape)) {
        properties[k] = convert(v);
        if (!v.isOptional()) required.push(k);
      }
      return withDesc({ type: "object", properties, required, additionalProperties: false });
    }
    default:
      throw new Error(`toJsonSchema: unsupported zod type ${def.typeName}`);
  }
}
