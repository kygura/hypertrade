// Lab tool registry (LAB.md "Surfaces" and "Tool contract"). One definition
// per tool: hand-written JSON Schema for clients, zod for validation, and a
// handler that calls the lab service. REST, MCP (HTTP and stdio) and the CLI
// all serve these.
import { z } from "zod";
import type { PromptDef, ToolDef, ToolInputSchema } from "../mcp/types.js";
import { createLabService, parseInput, type LabService } from "./service.js";
import { ASSET_PATTERN, DaySchema, RuleSchema, SearchConfigSchema, TRANSFORMS } from "./types.js";

export type { PromptDef, ToolContext, ToolDef, ToolSource } from "../mcp/types.js";
export { ToolInputError } from "../mcp/types.js";

let shared: LabService | null = null;

/** The process-wide service, created on first use (importing this module connects to nothing). */
export function getLabService(): LabService {
  return (shared ??= createLabService());
}

// ---------------------------------------------------------------- arguments (zod)

const WINDOWS = z.array(z.number().int().min(2).max(365)).min(1).max(6);
const SLIPPAGE = z.number().min(0).max(200).default(10);
const CATEGORIES = ["price", "derivatives", "onchain", "sentiment", "macro", "liquidity", "social"] as const;

const Empty = z.object({}).strict();
const ListMetricsArgs = z.object({ provider: z.string().min(1).optional(), category: z.enum(CATEGORIES).optional(), asset: z.string().min(1).max(20).optional() }).strict();
const SearchArgs = SearchConfigSchema.strict();
const GetRunArgs = z.object({ id: z.string().min(1).max(128) }).strict();
const ListRunsArgs = z.object({ limit: z.number().int().min(1).max(200).default(20) }).strict();
const EvaluateArgs = z
  .object({
    rule: RuleSchema,
    from: DaySchema.optional(),
    to: DaySchema.optional(),
    slippageBps: SLIPPAGE,
    includeEquity: z.boolean().default(false),
    sensitivity: z.boolean().default(false),
    windows: WINDOWS.optional(),
  })
  .strict();
const SensitivityArgs = z.object({ rule: RuleSchema, windows: WINDOWS.optional(), slippageBps: SLIPPAGE }).strict();
const CatalogueListArgs = z.object({ asset: z.string().min(1).max(20).optional(), direction: z.enum(["long", "short"]).optional(), live: z.boolean().default(true) }).strict();
const SaveArgs = z
  .object({
    rule: RuleSchema,
    name: z.string().trim().min(1).max(120),
    note: z.string().max(2000).optional(),
    runId: z.string().uuid("expected a run id (uuid) from lab_search or lab_list_runs").optional(),
    origin: z.enum(["user", "agent", "seed"]).default("user"),
  })
  .strict();
const RemoveArgs = z.object({ id: z.string().min(1).max(128) }).strict();
const PulseArgs = z.object({ asset: z.string().min(1).max(20).optional() }).strict();

// ---------------------------------------------------------------- arguments (JSON Schema)

const obj = (properties: Record<string, unknown>, required: string[] = []): ToolInputSchema => ({
  type: "object",
  properties,
  ...(required.length && { required }),
  additionalProperties: false,
});

const daySchema = (description: string) => ({ type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description });
const windowsSchema = (description: string) => ({
  type: "array",
  items: { type: "integer", minimum: 2, maximum: 365 },
  minItems: 1,
  maxItems: 6,
  description,
});
const slippageSchema = { type: "number", minimum: 0, maximum: 200, description: "Cost per unit of position change, in basis points. Default 10." };
const assetSchema = (description: string) => ({ type: "string", minLength: 1, maxLength: 20, description });

const ruleSchema = {
  type: "object",
  description:
    "A rule, usually copied verbatim from a lab_search result (result.rules[i].rule) or a catalogue entry. In zone when every condition holds at the close of day t; then position +1 (long) or −1 (short) over day t+1.",
  properties: {
    asset: { type: "string", pattern: ASSET_PATTERN.source, description: "Asset symbol, e.g. BTC." },
    direction: { type: "string", enum: ["long", "short"] },
    horizonDays: { type: "integer", minimum: 1, maximum: 180, description: "Label horizon the rule was searched with (used for precision)." },
    conditions: {
      type: "array",
      minItems: 1,
      maxItems: 2,
      items: {
        type: "object",
        properties: {
          feature: {
            type: "string",
            description: "Feature id `<metric>|<transform>|<window>`, e.g. `cm:CapMVRVCur|z|90`; raw features use window 0 (`ht:funding|raw|0`).",
          },
          op: { type: "string", enum: ["<", ">="] },
          threshold: { type: "number" },
        },
        required: ["feature", "op", "threshold"],
      },
    },
    price: { type: "string", description: "Price metric traded; default ht:price (falls back to cm:PriceUSD)." },
  },
  required: ["asset", "direction", "horizonDays", "conditions"],
};

const searchSchema = obj(
  {
    asset: { type: "string", pattern: ASSET_PATTERN.source, description: "Asset to research, e.g. BTC, ETH, SOL." },
    direction: { type: "string", enum: ["long", "short"], description: "Side the rules trade. Default long." },
    metrics: {
      type: "array",
      items: { type: "string", minLength: 3 },
      minItems: 1,
      maxItems: 40,
      description:
        "Metric ids `<provider>:<key>` from lab_list_metrics, e.g. [\"cm:CapMVRVCur\",\"ht:funding\",\"fng:value\"]. 3–10 related metrics per search work best. Features = metrics × transforms × windows, capped at 600.",
    },
    transforms: {
      type: "array",
      items: { type: "string", enum: [...TRANSFORMS] },
      minItems: 1,
      description: "Feature transforms. Default all: raw, z (rolling z-score), rsi, ma_ratio (value/SMA − 1), roc (rate of change), vol (rolling stdev of log changes), pctile (rolling percentile 0–1).",
    },
    windows: windowsSchema("Rolling windows in days for every transform except raw. Default [7, 30, 90]."),
    horizonDays: { type: "integer", minimum: 1, maximum: 180, description: "Forward-return horizon that defines a good day. Default 14." },
    labelQuantile: {
      type: "number",
      minimum: 0.05,
      maximum: 0.5,
      description: "A day is good when its forward return is in this top (long) or bottom (short) quantile of the search region and has the right sign. Default 0.3.",
    },
    customZones: {
      type: "array",
      maxItems: 50,
      items: obj({ from: daySchema("Zone start, YYYY-MM-DD."), to: daySchema("Zone end, YYYY-MM-DD.") }, ["from", "to"]),
      description: "Optional date ranges to label as good instead of the quantile labels.",
    },
    objective: { type: "string", enum: ["sharpe", "return"], description: "What trials and rules are ranked by (walk-forward, net of slippage). Default sharpe." },
    trials: { type: "integer", minimum: 1, maximum: 200, description: "Search budget: number of forest trials. Default 40. More trials take longer." },
    folds: { type: "integer", minimum: 2, maximum: 6, description: "Walk-forward folds over the search region (first 80% of history). Default 3." },
    minSupport: { type: "integer", minimum: 5, description: "Minimum in-zone training days for a rule to be kept. Default 30." },
    slippageBps: { type: "number", minimum: 0, maximum: 200, description: "Cost per unit of position change, in basis points. Default 10." },
    topK: { type: "integer", minimum: 1, maximum: 50, description: "Rules returned. Default 10." },
    from: daySchema("Start of history, YYYY-MM-DD. Default: as early as the data goes. At least 365 days of price are required."),
    to: daySchema("End of history, YYYY-MM-DD. Default: today."),
    price: { type: "string", description: "Price metric for labels and returns. Default ht:price, falling back to cm:PriceUSD." },
    seed: { type: "integer", description: "PRNG seed; the same config on the same data gives the same rules. Default 42." },
  },
  ["asset", "metrics"],
);

// ---------------------------------------------------------------- tools

const HONESTY = "Results are historical research, net of slippage, not trading advice.";

export function labTools(service: LabService = getLabService()): ToolDef[] {
  return [
    {
      name: "lab_list_providers",
      title: "List data providers",
      description:
        "Lists the lab's data providers (hypertrade DB/Hyperliquid, Coin Metrics community, alternative.me Fear & Greed, DefiLlama) with source notes and metric counts. Instant, no external calls. Next: lab_list_metrics.",
      inputSchema: obj({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
      async run(args) {
        parseInput(Empty, args);
        return service.listProviders();
      },
    },
    {
      name: "lab_list_metrics",
      title: "List metrics",
      description:
        "Returns { metrics: MetricDef[] }: every metric id (`<provider>:<key>`) with name, category, scope (asset or global), supported assets, units, description and publication lag. Filter by provider, category or asset. Instant. Next: pick 3–10 related metrics and call lab_search.",
      inputSchema: obj({
        provider: { type: "string", description: "Provider id: ht, cm, fng or llama." },
        category: { type: "string", enum: [...CATEGORIES] },
        asset: assetSchema("Only metrics available for this asset (global metrics included)."),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
      async run(args) {
        return service.listMetrics(parseInput(ListMetricsArgs, args));
      },
    },
    {
      name: "lab_search",
      title: "Search for trading heuristics",
      description:
        "Searches the chosen metrics for simple one- or two-condition rules (\"when feature A < x and B ≥ y, go long\") that predict good forward returns, scored as strategies net of slippage. Fetches data from external providers and runs a seeded random-forest search: typically 5–50 s (server deadline ~50 s; it then returns the trials completed, with a warning). Returns { runId, result }: result.rules ranked by walk-forward objective, each with precision, support, inSample, walkForward, holdout (most recent 20%, never used for ranking), benchmark, sensitivity.stability and firingNow; plus featureImportance and warnings. The run is stored (runId). Next: compare walkForward vs holdout and stability on the top rules, then refine metrics/windows, lab_evaluate_rule a rule, or lab_catalogue_save the robust ones. " +
        HONESTY,
      inputSchema: searchSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      async run(args, ctx) {
        return service.search(parseInput(SearchArgs, args), ctx);
      },
    },
    {
      name: "lab_get_run",
      title: "Get a stored run",
      description:
        "Returns a stored search run (StoredRun: config, status, error, full result, duration) by id. Instant. Use it to re-read rules from an earlier lab_search without re-running it.",
      inputSchema: obj({ id: { type: "string", description: "Run id (uuid) from lab_search or lab_list_runs." } }, ["id"]),
      annotations: { readOnlyHint: true, openWorldHint: false },
      async run(args) {
        return service.getRun(parseInput(GetRunArgs, args).id);
      },
    },
    {
      name: "lab_list_runs",
      title: "List stored runs",
      description:
        "Returns { runs: RunSummary[] }, newest first: id, time, source, status, asset, direction, metric and rule counts, best walk-forward Sharpe, error. Instant. Next: lab_get_run for the full result.",
      inputSchema: obj({ limit: { type: "integer", minimum: 1, maximum: 200, description: "Maximum runs. Default 20." } }),
      annotations: { readOnlyHint: true, openWorldHint: false },
      async run(args) {
        return service.listRuns(parseInput(ListRunsArgs, args).limit);
      },
    },
    {
      name: "lab_evaluate_rule",
      title: "Evaluate a rule",
      description:
        "Scores one explicit rule over its full history (or from/to): in-sample = first 80%, holdout = last 20%, benchmark (buy-and-hold or short-and-hold), precision, support, firingNow and the latest feature values. No walk-forward (there is no search to refit). Optional equity curve and sensitivity grid. Fetches data: a few seconds. Returns RuleEvaluation. Use it to test a hand-edited rule or a different window. " +
        HONESTY,
      inputSchema: obj(
        {
          rule: ruleSchema,
          from: daySchema("Evaluation start, YYYY-MM-DD. Features still warm up on earlier data."),
          to: daySchema("Evaluation end, YYYY-MM-DD. Default: latest data."),
          slippageBps: slippageSchema,
          includeEquity: { type: "boolean", description: "Include the daily equity curve (strategy and benchmark). Default false; large." },
          sensitivity: { type: "boolean", description: "Attach the parameter-sensitivity grid and stability score. Default false." },
          windows: windowsSchema("Windows swapped in for the sensitivity grid. Default [7, 30, 90]."),
        },
        ["rule"],
      ),
      annotations: { readOnlyHint: true, openWorldHint: true },
      async run(args) {
        return service.evaluateRule(parseInput(EvaluateArgs, args));
      },
    },
    {
      name: "lab_sensitivity",
      title: "Rule sensitivity",
      description:
        "Parameter-sensitivity grid for a rule: each threshold shifted to quantiles q ± 0.05 and q ± 0.10, each window swapped for its neighbours. Returns Sensitivity { base, stability (0–1, share of perturbations that keep the Sharpe sign and at least half its size), points }. Stability below 0.5 means the rule only works at one exact setting. Fetches data: a few seconds.",
      inputSchema: obj({ rule: ruleSchema, windows: windowsSchema("Windows to swap in. Default [7, 30, 90]."), slippageBps: slippageSchema }, ["rule"]),
      annotations: { readOnlyHint: true, openWorldHint: true },
      async run(args) {
        return service.sensitivity(parseInput(SensitivityArgs, args));
      },
    },
    {
      name: "lab_catalogue_list",
      title: "List My Catalogue",
      description:
        "Returns { entries }: saved rules (newest first) with their evaluation at save time, live performance since savedAt (live: PerfStats | null, out of sample by construction) and flags (\"decayed\", \"overlap\"). live=true fetches data for every listed asset (seconds); live=false is instant and returns live null, flags []. Next: lab_catalogue_health for details, lab_catalogue_remove to retire a decayed rule.",
      inputSchema: obj({
        asset: assetSchema("Only rules on this asset."),
        direction: { type: "string", enum: ["long", "short"] },
        live: { type: "boolean", description: "Compute live performance and flags. Default true." },
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
      async run(args) {
        return service.catalogueList(parseInput(CatalogueListArgs, args));
      },
    },
    {
      name: "lab_catalogue_save",
      title: "Save a rule to My Catalogue",
      description:
        "Saves a rule to the catalogue under its stable id (the same id as in search results). The rule is re-evaluated on current data and that evaluation is stored; live tracking starts now. Saving an existing rule updates its name/note and keeps its original savedAt. Returns CatalogueEntry. Save only rules that held up out of sample (walk-forward Sharpe > 1, holdout Sharpe > 0, stability ≥ 0.5). Agents: pass origin \"agent\" and the runId.",
      inputSchema: obj(
        {
          rule: ruleSchema,
          name: { type: "string", minLength: 1, maxLength: 120, description: "Short human name, e.g. \"BTC MVRV washout\"." },
          note: { type: "string", maxLength: 2000, description: "Why it was saved: the evidence and caveats." },
          runId: { type: "string", description: "The lab_search run the rule came from (uuid)." },
          origin: { type: "string", enum: ["user", "agent", "seed"], description: "Who saved it. Default user." },
        },
        ["rule", "name"],
      ),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      async run(args) {
        return service.catalogueSave(parseInput(SaveArgs, args));
      },
    },
    {
      name: "lab_catalogue_remove",
      title: "Remove a rule from My Catalogue",
      description: "Archives a catalogue rule by id; it stops appearing in the catalogue, health and Market Pulse. Returns { removed } (false if no active rule had that id). Instant.",
      inputSchema: obj({ id: { type: "string", description: "Rule id (catalogue entry id)." } }, ["id"]),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      async run(args) {
        return service.catalogueRemove(parseInput(RemoveArgs, args).id);
      },
    },
    {
      name: "lab_catalogue_health",
      title: "Catalogue health",
      description:
        "Checks the whole catalogue. Returns CatalogueHealth: decayed (≥ 30 live days and live Sharpe < max(0, 0.25 × holdout Sharpe)), overlaps (same-asset pairs whose in-zone days have Jaccard ≥ 0.6), gaps (asset × direction with no rule) and live (id → PerfStats | null). Fetches data per asset: seconds. Next: remove decayed rules, keep one of each overlapping pair, lab_search to fill gaps.",
      inputSchema: obj({}),
      annotations: { readOnlyHint: true, openWorldHint: true },
      async run(args) {
        parseInput(Empty, args);
        return service.catalogueHealth();
      },
    },
    {
      name: "lab_market_pulse",
      title: "Market Pulse",
      description:
        "Which catalogued rules fire on the latest data. Returns MarketPulse: per asset longActive/longTotal, shortActive/shortTotal, lean = (longActive − shortActive) / (longTotal + shortTotal) in −1..1, and each rule with firing; warnings name rules whose data could not load. Fetches data per asset: seconds. " +
        HONESTY,
      inputSchema: obj({ asset: assetSchema("Only this asset. Default: every asset in the catalogue.") }),
      annotations: { readOnlyHint: true, openWorldHint: true },
      async run(args) {
        return service.marketPulse(parseInput(PulseArgs, args));
      },
    },
  ];
}

// ---------------------------------------------------------------- prompts and instructions

const MAX_ROUNDS = 5;

export function labPrompts(): PromptDef[] {
  return [
    {
      name: "autoresearch",
      description: "Step-by-step research loop: search metric groups, check robustness, refine, save only rules that hold up out of sample, report.",
      arguments: [
        { name: "asset", description: "Asset to research, e.g. BTC.", required: true },
        { name: "direction", description: "long or short (default long)." },
        { name: "objective", description: "sharpe or return (default sharpe)." },
        { name: "goal", description: "What you are looking for, e.g. \"swing entries after capitulation\"." },
      ],
      render(a) {
        const asset = a.asset!;
        const direction = a.direction === "short" ? "short" : "long";
        const objective = a.objective === "return" ? "return" : "sharpe";
        return [
          `Research ${direction} heuristics for ${asset} in Hypertrade Lab, objective ${objective}.${a.goal ? ` Goal: ${a.goal}.` : ""}`,
          "",
          "Loop:",
          `1. lab_list_metrics { "asset": "${asset}" }. Group the metrics by category (onchain, derivatives, sentiment, macro, liquidity, price).`,
          `2. lab_search { "asset": "${asset}", "direction": "${direction}", "objective": "${objective}", "metrics": [one group of 3–10 metrics] } (default horizonDays 14, trials 40; 5–50 s). Keep the runId.`,
          "3. For the top rules, check: walkForward vs holdout Sharpe (a big drop means overfit), support and trades (too few = noise), sensitivity.stability (below 0.5 = fragile; lab_sensitivity if missing), and the benchmark.",
          "4. Refine: drop metrics absent from featureImportance, try another group or a mix of the strongest features, change windows or horizonDays. Write down what you changed and why.",
          `5. Repeat steps 2–4, at most ${MAX_ROUNDS} searches in total.`,
          `6. Save with lab_catalogue_save (origin "agent", runId, a note with the evidence) ONLY rules with walkForward Sharpe > 1, holdout Sharpe > 0 and stability ≥ 0.5. Then lab_catalogue_health: if a new rule overlaps an existing one, keep the better and remove the other.`,
          "7. Report: rules saved (text, walk-forward and holdout Sharpe, stability, trades per year, firingNow), promising rules rejected and why, and what to try next.",
          "",
          "Rules: rank and choose by walk-forward results only; the holdout confirms, it never selects. Do not re-run searches to chase a better holdout number. Say plainly when nothing passed. Results are historical research, not trading advice.",
        ].join("\n");
      },
    },
  ];
}

export const LAB_INSTRUCTIONS = `Hypertrade Lab finds simple, human-readable trading heuristics for crypto assets ("when cm:CapMVRVCur z(90) < -1.1 and ht:funding ≥ 0, go long BTC"), scores them as strategies net of slippage, validates them out of sample and tracks the ones you save.

Loop: lab_list_metrics → lab_search with a small related metric group (5–50 s) → inspect walk-forward vs holdout and stability of the top rules → refine metrics, windows or horizon → lab_catalogue_save only rules that hold up → lab_catalogue_health and lab_market_pulse to monitor. The autoresearch prompt walks through it.

Honesty rules: rank and select by walk-forward results. The holdout (most recent 20%) is never used for selection; treat it as a one-shot check. Low support, few trades or stability below 0.5 mean the rule is likely noise. Every number is historical research, not investment advice.`;
