import { z } from "zod";
import { MarketStateDataSchema } from "../../shared/schemas.js";
import latestMarketState from "../../../data/marketstate/latest.json" with { type: "json" };
import { MARKETSTATE_HISTORY } from "../../../data/marketstate/index.js";
import { seriesRange, summaryFor } from "../db.js";
import { engineFetch, type EngineResult } from "../routes/engine.js";
import { getMarkets, type MarketRow } from "../routes/hl.js";
import { getSectorsPayload } from "../routes/sectors.js";
import { defaultLabToolDeps, isLabTool, LAB_READ_TOOL_SPECS, runLabTool, type LabToolDeps } from "../lab/tools.js";
import type { ToolSpec } from "./provider.js";

// The analyst's tools: read-only views over data the app already serves.
// Every tool maps onto an existing server function; none writes, and none
// reaches the engine's approve/reject/kill/config endpoints. Results are
// compact JSON (capped) so a tool round stays cheap.

export const MAX_TOOL_CHARS = 12_000;

/** The metric strip's series (Overview) — the default for get_metrics_summary. */
export const DEFAULT_METRIC_IDS = [
  "hl.total_oi_usd",
  "hl.funding_skew",
  "fng.value",
  "cg.btc_dominance",
  "cg.total_mcap_usd",
  "llama.stablecoin_cap_usd",
];

/** Data access the tools need; injectable so tests run without DB/network. */
export interface ToolDeps {
  marketstateLatest(): unknown;
  marketstateHistory(): Array<{ date: string; data: unknown }>;
  sectors(): Promise<unknown>;
  metricsSummary(ids: string[]): Promise<unknown>;
  series(id: string, from: string | undefined, buckets: number): Promise<unknown>;
  hlMarkets(): Promise<{ fetchedAt: string; markets: MarketRow[] }>;
  engine(rest: string): Promise<EngineResult>;
  /** Lab research tools (read-only subset: the analyst never saves to the catalogue). */
  lab?: LabToolDeps;
}

export const defaultToolDeps: ToolDeps = {
  marketstateLatest: () => MarketStateDataSchema.parse(latestMarketState),
  marketstateHistory: () => MARKETSTATE_HISTORY,
  sectors: () => getSectorsPayload(),
  metricsSummary: (ids) => summaryFor(ids),
  series: (id, from, buckets) => seriesRange(id, from, undefined, buckets),
  hlMarkets: () => getMarkets(),
  engine: (rest) => engineFetch(rest),
};

const empty = { type: "object" as const, properties: {}, additionalProperties: false };

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: "get_marketstate",
    description:
      "The MarketState briefing written by the cloud routine: headline, tldr, domains with signals, thesis (observe/infer/forecast) and risks. Without a date returns the latest briefing plus the list of dated briefings available; with a date (YYYY-MM-DD from that list) returns that day's briefing. Use two dates to answer 'what changed since the last briefing'.",
    input_schema: {
      type: "object",
      properties: { date: { type: "string", description: "YYYY-MM-DD from the history list; omit for latest" } },
      additionalProperties: false,
    },
  },
  {
    name: "get_sectors",
    description:
      "The routine's sector/narrative map (mindshare 0-1, momentum -1..1, rationale, tokens, rotations with confidence) joined with live Hyperliquid aggregates per sector (total OI in USD, average funding, per-token rows).",
    input_schema: empty,
  },
  {
    name: "get_metrics_summary",
    description:
      "Latest value, previous value, delta, 30/90-observation means and z30 for collected series. Default ids: " +
      DEFAULT_METRIC_IDS.join(", ") +
      ". Other ids follow hl.oi.<COIN>, hl.funding.<COIN>, hl.premium.<COIN>, fred.<SERIES>.",
    input_schema: {
      type: "object",
      properties: { ids: { type: "array", items: { type: "string" }, maxItems: 20, description: "series ids; omit for the default strip" } },
      additionalProperties: false,
    },
  },
  {
    name: "get_series",
    description: "Downsampled history of one collected series (ts, value), oldest first.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "series id, e.g. hl.total_oi_usd" },
        from: { type: "string", description: "ISO date lower bound; omit for all history" },
        buckets: { type: "integer", minimum: 5, maximum: 200, description: "max points (default 60)" },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "get_hl_markets",
    description:
      "Live Hyperliquid perp universe: mark, oracle, premium, hourly funding, open interest (USD), 24h volume and 24h change, sorted by open interest. Returns the top `limit` (default 25) or the named coins.",
    input_schema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 100 },
        coins: { type: "array", items: { type: "string" }, maxItems: 30 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_engine_strategies",
    description:
      "Strategies configured on the Hyperion engine (Jev-driven strategy runtime): id, enabled, venue, cadence, last run, last action, last error, and the governor settings. Read-only; returns an error object when the engine is not connected.",
    input_schema: empty,
  },
  {
    name: "get_engine_decisions",
    description:
      "Recent engine decision records, newest first: strategy, venue, dry_run, Jev answers per question (choice/score/noul with probabilities and confidence), intents, governor verdicts, model, latency. Read-only.",
    input_schema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 20, description: "default 5" },
        strategy: { type: "string", description: "filter by strategy id" },
      },
      additionalProperties: false,
    },
  },
  ...LAB_READ_TOOL_SPECS,
];

const inputs = {
  get_marketstate: z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).strict(),
  get_sectors: z.object({}).strict(),
  get_metrics_summary: z.object({ ids: z.array(z.string().min(1).max(80)).max(20).optional() }).strict(),
  get_series: z
    .object({ id: z.string().min(1).max(80), from: z.string().max(40).optional(), buckets: z.number().int().min(5).max(200).optional() })
    .strict(),
  get_hl_markets: z
    .object({ limit: z.number().int().min(1).max(100).optional(), coins: z.array(z.string().min(1).max(20)).max(30).optional() })
    .strict(),
  get_engine_strategies: z.object({}).strict(),
  get_engine_decisions: z
    .object({ limit: z.number().int().min(1).max(20).optional(), strategy: z.string().regex(/^[a-z0-9_]+$/).max(64).optional() })
    .strict(),
} as const;

export type ToolName = keyof typeof inputs;

export interface ToolRun {
  content: string;
  summary: string;
  isError: boolean;
}

function clip(v: unknown): string {
  const s = JSON.stringify(v);
  return s.length <= MAX_TOOL_CHARS ? s : `${s.slice(0, MAX_TOOL_CHARS)}…[truncated ${s.length - MAX_TOOL_CHARS} chars]`;
}

function fail(summary: string, detail: Record<string, unknown> = {}): ToolRun {
  return { content: JSON.stringify({ error: summary, ...detail }), summary, isError: true };
}

/** Runs one tool call. Never throws: failures become is_error results the model can read. */
export async function runTool(name: string, rawInput: unknown, deps: ToolDeps = defaultToolDeps): Promise<ToolRun> {
  if (isLabTool(name) && name !== "lab_save_rule") return runLabTool(name, rawInput, deps.lab ?? defaultLabToolDeps);
  const schema = (inputs as Record<string, z.ZodTypeAny>)[name];
  if (!schema) return fail(`unknown tool ${name}`);
  const parsed = schema.safeParse(rawInput ?? {});
  if (!parsed.success) return fail("invalid input", { issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) });
  try {
    return await dispatch(name as ToolName, parsed.data, deps);
  } catch (err) {
    return fail(`${name} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function dispatch(name: ToolName, input: any, deps: ToolDeps): Promise<ToolRun> {
  switch (name) {
    case "get_marketstate": {
      const history = deps.marketstateHistory();
      if (input.date) {
        const entry = history.find((h) => h.date === input.date);
        if (!entry) return fail(`no briefing for ${input.date}`, { available: history.map((h) => h.date) });
        return { content: clip(entry.data), summary: `briefing ${input.date}`, isError: false };
      }
      const latest = deps.marketstateLatest() as { generated_at?: string; headline?: string };
      return {
        content: clip({ latest, history: history.map((h) => h.date) }),
        summary: `latest briefing ${latest.generated_at ?? ""} · ${history.length} dated`,
        isError: false,
      };
    }
    case "get_sectors": {
      const data = (await deps.sectors()) as { generated_at?: string; sectors?: unknown[]; rotations?: unknown[] };
      return {
        content: clip(data),
        summary: `${data.sectors?.length ?? 0} sectors · ${data.rotations?.length ?? 0} rotations · ${data.generated_at ?? ""}`,
        isError: false,
      };
    }
    case "get_metrics_summary": {
      const ids: string[] = input.ids?.length ? input.ids : DEFAULT_METRIC_IDS;
      const rows = (await deps.metricsSummary(ids)) as unknown[];
      return { content: clip(rows), summary: `${rows.length} series`, isError: false };
    }
    case "get_series": {
      const pts = (await deps.series(input.id, input.from, input.buckets ?? 60)) as unknown[];
      return { content: clip({ id: input.id, points: pts }), summary: `${input.id}: ${pts.length} points`, isError: false };
    }
    case "get_hl_markets": {
      const { fetchedAt, markets } = await deps.hlMarkets();
      let rows = markets;
      if (input.coins?.length) {
        const want = new Set((input.coins as string[]).map((c) => c.toUpperCase()));
        rows = markets.filter((m) => want.has(m.coin.toUpperCase()));
      } else {
        rows = markets.slice(0, input.limit ?? 25);
      }
      return { content: clip({ fetchedAt, markets: rows }), summary: `${rows.length} markets @ ${fetchedAt}`, isError: false };
    }
    case "get_engine_strategies": {
      const [configs, governor] = await Promise.all([deps.engine("configs"), deps.engine("governor")]);
      if (configs.status >= 400) return engineFail(configs);
      const list = ((configs.json as { strategies?: any[] }).strategies ?? []).map((s) => ({
        id: s.manifest?.id,
        name: s.manifest?.name,
        enabled: s.config?.enabled,
        venue: s.config?.venue,
        cadence: s.manifest?.cadence,
        markets: s.config?.params?.markets ?? s.manifest?.markets,
        last_run_at: s.last_run_at,
        last_action: s.last_action,
        last_error: s.last_error || undefined,
        next_run_at: s.next_run_at,
        governor_override: s.config?.governor,
      }));
      return {
        content: clip({ strategies: list, governor: governor.status < 400 ? governor.json : undefined }),
        summary: `${list.length} strategies · ${list.filter((s) => s.enabled).length} enabled`,
        isError: false,
      };
    }
    case "get_engine_decisions": {
      const q = new URLSearchParams({ limit: String(input.limit ?? 5) });
      if (input.strategy) q.set("strategy", input.strategy);
      const res = await deps.engine(`decisions?${q}`);
      if (res.status >= 400) return engineFail(res);
      const decisions = ((res.json as { decisions?: any[] }).decisions ?? []).map((d) => ({
        id: d.id,
        ts: d.ts,
        strategy_id: d.strategy_id,
        venue: d.venue,
        dry_run: d.dry_run,
        state: d.state,
        answers: d.answers,
        intents: d.intents,
        verdicts: d.verdicts,
        model: d.model,
        latency_ms: d.latency_ms,
        error: d.error || undefined,
      }));
      return { content: clip({ decisions }), summary: `${decisions.length} decisions`, isError: false };
    }
  }
}

function engineFail(res: EngineResult): ToolRun {
  const msg = (res.json as { error?: string })?.error ?? `HTTP ${res.status}`;
  const note =
    msg === "engine not configured"
      ? "The Hyperion engine is not connected to this deployment (ENGINE_URL unset); say so rather than guessing engine state."
      : "The engine did not answer; treat engine state as unknown.";
  return fail(`engine: ${msg}`, { status: res.status, note });
}

/** Human-readable tool list for the status endpoint and the system prompt. */
export function toolCatalog(webSearch: boolean): Array<{ name: string; available: boolean; note?: string }> {
  return [
    ...TOOL_SPECS.map((t) => ({ name: t.name, available: true })),
    webSearch
      ? { name: "web_search", available: true, note: "provider-hosted web search" }
      : { name: "web_search", available: false, note: "only with Anthropic models" },
  ];
}
