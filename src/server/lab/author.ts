import { z } from "zod";
import type { LlmDeps } from "../intel/llm.js";
import type { ToolSpec } from "../llm/provider.js";
import { canonicalConditions, parseFeatureId, ruleId } from "./engine/index.js";
import { ASSET_PATTERN, RuleSchema, TRANSFORMS, type Direction, type MetricDef, type Rule } from "./types.js";

// Rule authoring from intent (FEATURES.md § 1). The LLM only recombines the
// audited feature vocabulary: every candidate is a plain `Rule`, validated
// against the metric catalogue before anyone sees it. completeStructured
// feeds a validation failure back once (the repair round), then fails closed.
// Nothing is saved here.

export const AUTHOR_PROMPT_VERSION = "lab-author-1";
export const MAX_CANDIDATES = 3;

export interface AuthorInput {
  intent: string;
  asset?: string;
  direction?: Direction;
}

export interface AuthorDeps {
  llm: LlmDeps;
  /** The metric catalogue candidates are validated against (already narrowed to the asset when one is given). */
  metrics: MetricDef[];
}

export type AuthorResult = { ok: true; rules: Rule[]; model: string | null } | { ok: false; error: string };

const jsonSchema: ToolSpec["input_schema"] = {
  type: "object",
  properties: {
    candidates: {
      type: "array",
      minItems: 1,
      maxItems: MAX_CANDIDATES,
      items: {
        type: "object",
        properties: {
          asset: { type: "string", pattern: ASSET_PATTERN.source },
          direction: { type: "string", enum: ["long", "short"] },
          horizonDays: { type: "integer", minimum: 1, maximum: 180 },
          conditions: {
            type: "array",
            minItems: 1,
            maxItems: 2,
            items: {
              type: "object",
              properties: {
                feature: { type: "string", description: "`<metric>|<transform>|<window>`; window 0 for raw." },
                op: { type: "string", enum: ["<", ">="] },
                threshold: { type: "number" },
              },
              required: ["feature", "op", "threshold"],
            },
          },
        },
        required: ["asset", "direction", "horizonDays", "conditions"],
      },
    },
  },
  required: ["candidates"],
};

/** Zod over the catalogue: the trust boundary for LLM output. */
function candidatesSchema(metrics: MetricDef[], input: AuthorInput) {
  const byId = new Map(metrics.map((m) => [m.id, m]));
  const rule = RuleSchema.strict().superRefine((r, ctx) => {
    const bad = (message: string, path: (string | number)[] = []) => ctx.addIssue({ code: "custom", message, path });
    if (input.asset && r.asset.toUpperCase() !== input.asset.toUpperCase()) bad(`asset must be ${input.asset}`, ["asset"]);
    if (input.direction && r.direction !== input.direction) bad(`direction must be ${input.direction}`, ["direction"]);
    if (r.price && !byId.has(r.price)) bad(`unknown price metric ${r.price}`, ["price"]);
    r.conditions.forEach((c, i) => {
      const at = ["conditions", i, "feature"];
      try {
        const s = parseFeatureId(c.feature);
        const m = byId.get(s.metric);
        if (!m) bad(`unknown metric ${s.metric}; use only ids from the catalogue`, at);
        else if (s.transform === "raw" && m.stationary === false) bad(`${s.metric} is a trending level: raw is not allowed, use a transform`, at);
      } catch (err) {
        bad(err instanceof Error ? err.message : String(err), at);
      }
    });
    if (!canonicalConditions(r.conditions)) bad("conditions can never hold together", ["conditions"]);
  });
  return z.object({ candidates: z.array(rule).min(1).max(MAX_CANDIDATES) }).strict();
}

const SYSTEM = `You translate a trader's idea into Lab rules. A rule is: asset, direction (long|short), horizonDays (1-180) and 1 or 2 conditions. A condition is {feature, op, threshold} with op "<" or ">=" and feature "<metric>|<transform>|<window>".
Transforms: ${TRANSFORMS.join(", ")}. Window is 0 for raw and 2-365 otherwise. Use ONLY metric ids from the catalogue in the user message.
Rules for candidates: use the fewest conditions that express the idea (one if one is enough); round, defensible thresholds (e.g. z-scores -1, -2, 1, 2; percentiles 0.1, 0.9), never tuned values; no near-duplicate filters (do not stack two transforms of one metric); return 1 to ${MAX_CANDIDATES} genuinely different readings of the idea, fewer is better. You do not predict returns or judge the idea: you only write rules.`;

export async function authorRules(input: AuthorInput, deps: AuthorDeps): Promise<AuthorResult> {
  const catalogue = deps.metrics.map((m) => `${m.id} (${m.category}${m.stationary === false ? ", level: no raw" : ""}) ${m.name}`).join("\n");
  const user = [
    `Idea: ${input.intent}`,
    input.asset ? `Asset: ${input.asset}` : "Asset: choose from the idea (default BTC).",
    input.direction ? `Direction: ${input.direction}` : "Direction: choose from the idea.",
    `Metric catalogue:\n${catalogue}`,
  ].join("\n\n");
  // Imported on first use: the Intel/Desk graph imports the lab tools, so a static import would be a cycle.
  const { completeStructured } = await import("../intel/llm.js");
  const r = await completeStructured({
    tier: "strong",
    system: SYSTEM,
    user,
    schema: candidatesSchema(deps.metrics, input),
    jsonSchema,
    promptVersion: AUTHOR_PROMPT_VERSION,
    deps: deps.llm,
  });
  if (!r.ok) return { ok: false, error: r.error };
  const rules = new Map<string, Rule>();
  for (const c of r.value.candidates) rules.set(ruleId(c), c); // equal rules merge
  return { ok: true, rules: [...rules.values()], model: r.trace.model };
}
