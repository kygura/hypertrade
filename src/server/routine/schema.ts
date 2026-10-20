import { z, type ZodTypeAny } from "zod";
import type { ToolSpec } from "../llm/provider.js";
import { MarketStateDataSchema, SectorsDataSchema } from "../../shared/schemas.js";
import { DirectionSchema, HorizonSchema } from "../../shared/setups.js";

// Data shapes of the fallback routine (docs/fallback-routine.md § Data
// shapes). Persisted shapes (Setup, Ledger, HtfView) are what lives in
// data/setups/*.json; the *Draft / *Output shapes are what the model may
// emit. Fields the code owns (ids, status, rr, timestamps) never appear in a
// model shape, so the model cannot set them.

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

/** The part of the HTF view the model writes; the code adds the timestamps and the hl-cycles state. */
export const HtfViewDraftSchema = z.object({
  regime: z.enum(["risk_on", "neutral", "risk_off"]),
  stance: z.enum(["trend_long", "range", "trend_short", "stand_aside"]).describe("stand_aside blocks every new setup until the next refresh"),
  thesis: z.string().min(1).max(1500).describe("The long-term view, 3-6 sentences, citing measured numbers"),
  biases: z.array(BiasSchema).max(4).describe("BTC, ETH, SOL, HYPE"),
  what_changes_it: z.array(z.string().min(1).max(300)).min(1).max(5).describe("Checkable: a metric, a threshold and a direction"),
});
export const HtfViewSchema = HtfViewDraftSchema.extend({
  generated_at: z.string(),
  valid_until: z.string(),
  hl_cycles_state: z.string().nullable(),
});
export type HtfView = z.infer<typeof HtfViewSchema>;

export const SetupProposalSchema = z.object({
  asset: z.string().min(1).max(24).describe("Hyperliquid symbol, case-sensitive"),
  direction: DirectionSchema,
  horizon: HorizonSchema.describe("swing: expires within 10 days"),
  thesis: z.string().min(1).max(800).describe("Why, citing measured numbers from the context"),
  regime_alignment: z.enum(["with", "counter"]).describe("counter = fights the HTF view; must then be conviction low"),
  trigger: z.string().min(1).max(300).describe("The checkable condition a human would act on"),
  entry: z.object({ low: Price, high: Price }),
  invalidation: Price,
  invalidation_reason: z.string().min(1).max(300),
  targets: z.array(Price).min(1).max(3).describe("In profit order"),
  conviction: z.enum(["low", "medium", "high"]),
  evidence: z.array(z.string().max(120)).min(1).max(8).describe("Context keys the setup rests on, e.g. hl-cycles.levels.sth_cost_basis"),
  expires_at: z.string().describe("ISO-8601 UTC time after which the plan lapses"),
});
export type SetupProposal = z.infer<typeof SetupProposalSchema>;

export const PulseOutputSchema = z.object({
  regime_read: z.string().min(1).max(400).describe("One or two sentences: where we stand"),
  htf_view: HtfViewDraftSchema.nullable().describe("Required when the context says an HTF refresh is due; otherwise null"),
  new_setups: z.array(SetupProposalSchema).max(3).describe("0-3 proposals; an empty list is a normal answer"),
  cancel: z.array(z.object({ id: z.string(), reason: z.string().min(1).max(300) })).max(5).describe("Open setups whose thesis broke before price did"),
  stand_aside_reason: z.string().max(400).nullable().describe("Required when new_setups is empty"),
  brief: z.string().min(1).max(1500).describe("Short delta-first text for a human"),
});
export type PulseOutput = z.infer<typeof PulseOutputSchema>;

/** Pulse output plus the cross-field rules the model must meet (completeStructured retries once on a miss). */
export function pulseOutputSchema(htfDue: boolean, setupsAllowed = true) {
  return PulseOutputSchema.superRefine((o, ctx) => {
    if (htfDue && !o.htf_view) ctx.addIssue({ code: "custom", path: ["htf_view"], message: "an HTF refresh is due: htf_view is required" });
    if (setupsAllowed && o.new_setups.length === 0 && !o.stand_aside_reason?.trim()) ctx.addIssue({ code: "custom", path: ["stand_aside_reason"], message: "required when new_setups is empty" });
  });
}

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
