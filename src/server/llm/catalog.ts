import type { Effort } from "./provider.js";
import {
  DEFAULT_MODEL,
  anthropicCredentials,
  openaiCredentials,
  presetCredentials,
  rawProviderKind,
  type AnalystEnv,
  type ProviderId,
} from "./provider.js";
import { PRESETS, parseModelList, type CatalogModel, type Tier } from "./presets.js";

export type { CatalogModel, Tier };

// The analyst's model/provider catalog (GET /api/analyst/models). Lists
// what a client may pick for POST /api/analyst/query's optional
// provider/model/effort fields, and whether each provider is configured at
// all — 200 even when nothing is configured, so the UI can explain what to
// set (DESIGN.md state vocabulary §6, "unconfigured").
//
// Anthropic's list is hand-maintained here; the vendor presets' lists live
// in presets.ts; the generic openai-compatible slot lists whatever the
// deployment names via ANALYST_MODELS/DESK_ANALYST_MODEL, since an arbitrary
// endpoint's models are not knowable ahead of time.

export interface ProviderCatalogEntry {
  id: ProviderId;
  label: string;
  /** Short line under the provider name in the picker. */
  blurb: string;
  available: boolean;
  /** Present only when unavailable — what env var(s) to set. */
  reason?: string;
  /** Provider-hosted web search (Anthropic only). */
  webSearch: boolean;
  models: CatalogModel[];
}

export interface AnalystCatalog {
  default: { provider: ProviderId; model: string };
  providers: ProviderCatalogEntry[];
}

const ALL: Effort[] = ["low", "medium", "high", "xhigh", "max"];

/**
 * The current Claude lineup, checked against the claude-api skill's model
 * table (2026-09-25; exact ids, no date suffixes). Fable 5.1, Opus 5.5 and
 * Sonnet 5.5 take low..max effort — Opus 5.5 defaults to medium, the others
 * to high. Haiku 4.5 takes no effort level (it still uses budget_tokens
 * thinking, which this app does not expose). Re-run the skill before
 * changing ids.
 */
export const ANTHROPIC_MODELS: CatalogModel[] = [
  {
    id: "claude-fable-5-1",
    label: "Fable 5.1",
    note: "Most capable — hardest reasoning, long multi-tool digs",
    tier: "frontier",
    effort: true,
    efforts: ALL,
    defaultEffort: "high",
  },
  {
    id: "claude-opus-5-5",
    label: "Opus 5.5",
    note: "Deep multi-step market reads, cheaper than Fable",
    tier: "frontier",
    effort: true,
    efforts: ALL,
    defaultEffort: "medium",
  },
  {
    id: "claude-sonnet-5-5",
    label: "Sonnet 5.5",
    note: "Balanced daily driver for most analyst questions",
    tier: "balanced",
    effort: true,
    efforts: ALL,
    defaultEffort: "medium",
  },
  {
    id: "claude-haiku-4-5",
    label: "Haiku 4.5",
    note: "Fast, cheap answers for quick lookups",
    tier: "fast",
    effort: false,
  },
];

/** Which provider ANALYST_PROVIDER/DESK_ANALYST_MODEL apply to (`default`). An
 * unrecognised value falls back to "anthropic" — purely for labelling; it
 * does not grant anthropic the legacy ANALYST_API_KEY fallback. */
function catalogDefaultProvider(env: AnalystEnv): ProviderId {
  const raw = rawProviderKind(env);
  return raw === "unknown" ? "anthropic" : raw;
}

/**
 * The generic openai-compatible slot's models: ANALYST_MODELS
 * ("id,id2=Label Two,id3"), else the single DESK_ANALYST_MODEL — but only when
 * openai-compatible is the default provider (DESK_ANALYST_MODEL otherwise belongs
 * to the default provider's own settings).
 */
export function parseOpenAIModels(env: AnalystEnv): CatalogModel[] {
  const note = "From ANALYST_MODELS/DESK_ANALYST_MODEL — capabilities unknown for this endpoint";
  const listed = parseModelList(env.ANALYST_MODELS, note);
  if (listed.length) return listed;
  if (catalogDefaultProvider(env) === "openai-compatible") {
    const model = env.DESK_ANALYST_MODEL?.trim();
    if (model) return [{ id: model, label: model, note, tier: "balanced", effort: false }];
  }
  return [];
}

function openaiReason(apiKey: string | undefined, baseURL: string | undefined): string | undefined {
  if (!apiKey && !baseURL) return "set ANALYST_OPENAI_API_KEY and ANALYST_OPENAI_BASE_URL";
  if (!apiKey) return "set ANALYST_OPENAI_API_KEY";
  if (!baseURL) return "set ANALYST_OPENAI_BASE_URL";
  return undefined;
}

/** Builds the full catalog for GET /api/analyst/models. Always 200-able:
 * every field resolves even when nothing is configured. */
export function buildCatalog(env: AnalystEnv): AnalystCatalog {
  const anthropic = anthropicCredentials(env);
  const openai = openaiCredentials(env);
  const openaiModels = parseOpenAIModels(env);

  const providers: ProviderCatalogEntry[] = [
    {
      id: "anthropic",
      label: "Anthropic",
      blurb: "Claude Fable 5.1, Opus 5.5, Sonnet 5.5, Haiku 4.5 · web search",
      available: !!anthropic.apiKey,
      reason: anthropic.apiKey ? undefined : "set ANTHROPIC_API_KEY or ANALYST_ANTHROPIC_API_KEY",
      webSearch: true,
      models: ANTHROPIC_MODELS,
    },
    ...PRESETS.map((p): ProviderCatalogEntry => {
      const cfg = presetCredentials(p, env);
      const hasModels = cfg.models.length > 0;
      const available = !!cfg.apiKey && hasModels;
      return {
        id: p.id,
        label: p.label,
        blurb: p.blurb,
        available,
        reason: !cfg.apiKey ? `set ${p.keyEnv[p.keyEnv.length - 1]}` : !hasModels ? `set ${p.modelsEnv}` : undefined,
        webSearch: false,
        models: cfg.models,
      };
    }),
    {
      id: "openai-compatible",
      label: "Custom endpoint",
      blurb: "Any OpenAI-compatible server (gateway, local model)",
      available: !!openai.apiKey && !!openai.baseURL && openaiModels.length > 0,
      reason: openaiReason(openai.apiKey, openai.baseURL) ?? (openaiModels.length ? undefined : "set ANALYST_MODELS"),
      webSearch: false,
      models: openaiModels,
    },
  ];

  const defaultProvider = catalogDefaultProvider(env);
  const entry = providers.find((p) => p.id === defaultProvider)!;
  const defaultModel =
    defaultProvider === "anthropic" ? env.DESK_ANALYST_MODEL?.trim() || DEFAULT_MODEL : env.DESK_ANALYST_MODEL?.trim() || entry.models[0]?.id || "";

  return { default: { provider: defaultProvider, model: defaultModel }, providers };
}
