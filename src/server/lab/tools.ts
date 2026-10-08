// Lab tools for models: the analyst gets the read-only four, the MCP server
// (scripts/lab-mcp.ts) also gets lab_save_rule. Same inputs, same outputs.
import { z } from "zod";
import { LAB_BASES, LAB_TRANSFORMS, LabRuleSchema, LabSearchRequestSchema } from "../../shared/lab.js";
import type { ToolSpec } from "../llm/provider.js";
import { LabError } from "./search.js";
import { compactReport, labCatalogue, LabDuplicateError, labEvaluate, labFeatures, labSave, labSearch } from "./service.js";

export interface LabToolRun {
  content: string;
  summary: string;
  isError: boolean;
}

export interface LabToolDeps {
  features: typeof labFeatures;
  search: typeof labSearch;
  evaluate: typeof labEvaluate;
  catalogue: typeof labCatalogue;
  save: typeof labSave;
}
export const defaultLabToolDeps: LabToolDeps = { features: labFeatures, search: labSearch, evaluate: labEvaluate, catalogue: labCatalogue, save: labSave };

const ruleSchemaJson = {
  type: "object",
  properties: {
    direction: { type: "string", enum: ["long", "short"] },
    conditions: {
      type: "array",
      minItems: 1,
      maxItems: 3,
      items: {
        type: "object",
        properties: {
          feature: { type: "string", description: "<base>|<transform>, e.g. cm.btc.CapMVRVCur|z365 (see lab_features)" },
          op: { type: "string", enum: ["<", ">"] },
          q: { type: "number", description: "quantile level of the train window, 0-1 exclusive (enables walk-forward)" },
          threshold: { type: "number", description: "absolute threshold; ratios are fractions (0.05 = +5%), percentiles 0-100" },
        },
        required: ["feature", "op"],
      },
    },
  },
  required: ["direction", "conditions"],
};

const METHOD =
  "Method: daily data, signal at close t trades close t to t+1, net of costBps per position change, flat cash when out. Last 20% of history is a holdout the search never reads; the rest is 5 folds with expanding-window walk-forward (thresholds refit before each fold). Single conditions are scored on walk-forward Sharpe; the best are ANDed into two-condition rules. Reports give in-sample, walk-forward and holdout stats, threshold stability (neighbour quantiles' Sharpe / own; < 0.5 is fragile) and a deflated Sharpe (probability the walk-forward Sharpe beats the best of all trials as noise; >= 0.95 is the bar).";

export const LAB_READ_TOOL_SPECS: ToolSpec[] = [
  {
    name: "lab_features",
    description:
      "Lab base series (on-chain, mining, sentiment, liquidity, derivatives, price) with coverage dates and sync errors, plus the transforms a feature id can use. Call before lab_search or lab_evaluate_rule to pick bases and feature ids.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "lab_search",
    description:
      `Searches the Lab's free historical data for simple BTC trading rules (one or two threshold conditions) that maximise walk-forward Sharpe. Takes a few seconds. ${METHOD} Bases: ${LAB_BASES.map((b) => b.id).join(", ")}. Transforms: ${LAB_TRANSFORMS.map((t) => t.id).join(", ")}.`,
    input_schema: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["long", "short"], description: "default long" },
        bases: { type: "array", items: { type: "string" }, description: "base ids to search; default all with data" },
        transforms: { type: "array", items: { type: "string" }, description: "transform ids; default all" },
        from: { type: "string", description: "YYYY-MM-DD start; default 2015-01-01" },
        costBps: { type: "number", description: "cost per position change in bps, default 10" },
        effort: { type: "string", enum: ["quick", "standard", "deep"], description: "beam width for pairs; default standard" },
        maxResults: { type: "integer", minimum: 1, maximum: 25, description: "default 10" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "lab_evaluate_rule",
    description:
      "Backtests one rule on the same split as lab_search. Conditions given as q (quantile) get walk-forward stats; absolute thresholds are evaluated as fixed. Use to stress-test a found rule (change a threshold, drop a condition, flip direction, move the start date).",
    input_schema: {
      type: "object",
      properties: {
        rule: ruleSchemaJson,
        from: { type: "string", description: "YYYY-MM-DD start" },
        costBps: { type: "number" },
      },
      required: ["rule"],
      additionalProperties: false,
    },
  },
  {
    name: "lab_catalogue",
    description:
      "Saved Lab rules, each re-checked on today's data: firing now, stats since it was saved (data the search never saw) and full history, plus the pulse (active long vs short rules).",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
];

export const LAB_SAVE_TOOL_SPEC: ToolSpec = {
  name: "lab_save_rule",
  description: "Saves a rule report (from lab_search or lab_evaluate_rule, with resolved thresholds) to the catalogue so its live behaviour is tracked.",
  input_schema: {
    type: "object",
    properties: {
      rule: ruleSchemaJson,
      note: { type: "string", description: "why it is worth tracking" },
      from: { type: "string" },
      costBps: { type: "number" },
    },
    required: ["rule"],
    additionalProperties: false,
  },
};

export const LAB_TOOL_INPUTS = {
  lab_features: z.object({}).strict(),
  lab_search: LabSearchRequestSchema,
  lab_evaluate_rule: z.object({ rule: LabRuleSchema, from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), costBps: z.number().min(0).max(100).optional() }).strict(),
  lab_catalogue: z.object({}).strict(),
  lab_save_rule: z
    .object({ rule: LabRuleSchema, note: z.string().max(500).optional(), from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), costBps: z.number().min(0).max(100).optional() })
    .strict(),
} as const;
export type LabToolName = keyof typeof LAB_TOOL_INPUTS;
export const isLabTool = (name: string): name is LabToolName => name in LAB_TOOL_INPUTS;

const ok = (content: unknown, summary: string): LabToolRun => ({ content: JSON.stringify(content), summary, isError: false });
const err = (summary: string, detail: Record<string, unknown> = {}): LabToolRun => ({ content: JSON.stringify({ error: summary, ...detail }), summary, isError: true });

/** Never throws: failures come back as error results the model can read. */
export async function runLabTool(name: LabToolName, raw: unknown, deps: LabToolDeps = defaultLabToolDeps, source: "mcp" | "cli" = "mcp"): Promise<LabToolRun> {
  const parsed = LAB_TOOL_INPUTS[name].safeParse(raw ?? {});
  if (!parsed.success) return err("invalid input", { issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) });
  const input = parsed.data as any;
  try {
    switch (name) {
      case "lab_features": {
        const f = await deps.features();
        const withData = f.bases.filter((b) => b.coverage);
        return ok(
          {
            bases: f.bases.map((b) => ({ id: b.id, label: b.label, group: b.group, units: b.units, lagDays: b.lagDays, coverage: b.coverage, syncError: b.syncError ?? undefined })),
            transforms: f.transforms.map((t) => ({ id: t.id, label: t.label || "level", kind: t.kind })),
            note: "Trending bases (counts, USD totals, hash rate) have no raw transform.",
          },
          `${withData.length}/${f.bases.length} bases with data`,
        );
      }
      case "lab_search": {
        const res = await deps.search(input, { persist: false });
        return ok(
          {
            range: res.range,
            bases: res.bases,
            features: res.features,
            trials: res.trials,
            elapsedMs: res.elapsedMs,
            warnings: res.warnings,
            results: res.results.map(compactReport),
          },
          `${res.results.length} rules from ${res.trials} trials`,
        );
      }
      case "lab_evaluate_rule": {
        const r = await deps.evaluate(input);
        return ok(compactReport(r), r.text);
      }
      case "lab_catalogue": {
        const c = await deps.catalogue();
        return ok(
          {
            pulse: c.pulse,
            entries: c.entries.map((e) => ({ id: e.id, savedAt: e.createdAt, note: e.note, text: e.report.text, live: e.live, error: e.error })),
          },
          `${c.entries.length} saved · ${c.pulse.long.active} long / ${c.pulse.short.active} short active`,
        );
      }
      case "lab_save_rule": {
        const report = await deps.evaluate({ rule: input.rule, from: input.from, costBps: input.costBps });
        const saved = await deps.save({ report, note: input.note, source });
        return ok({ ...saved, text: report.text }, `saved ${report.text}`);
      }
    }
  } catch (e) {
    if (e instanceof LabError) return err(e.message);
    if (e instanceof LabDuplicateError) return err(e.message, { id: e.id });
    return err(`${name} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
