// OpenAI-compatible provider presets for the analyst. Every vendor below
// speaks Chat Completions with streamed function calls, so one client
// (openai.ts) serves them all; a preset only records what differs between
// them: endpoint, key env vars, a curated model list, which reasoning
// controls each model takes and how they go on the wire, and whether
// reasoning text has to be sent back on later turns.
//
// Model ids and request shapes checked against each vendor's docs on
// 2026-10-01 (sources in the README "Analyst" section). Update the lists
// here when a vendor ships or retires a model; a deployment can override
// any list with ANALYST_<PRESET>_MODELS without a code change.

import type { Effort } from "./provider.js";

export type Tier = "frontier" | "balanced" | "fast";

export interface CatalogModel {
  id: string;
  label: string;
  /** One-line "best for" note. */
  note: string;
  tier: Tier;
  /** Whether this model accepts the query's optional `effort` field. */
  effort: boolean;
  /** The effort levels it accepts (when `effort`), weakest first. */
  efforts?: Effort[];
  /** Effort used when the request names none. */
  defaultEffort?: Effort;
}

export type PresetId = "openai" | "google" | "xai" | "deepseek" | "moonshot" | "qwen" | "openrouter";

export interface Preset {
  id: PresetId;
  label: string;
  /** Short vendor line for the picker ("Kimi K3, K2.6"). */
  blurb: string;
  baseURL: string;
  /** Env vars checked in order for the key; the first set one wins. */
  keyEnv: string[];
  /** Overrides the base URL (proxies, regional endpoints). */
  baseUrlEnv: string;
  /** "id,id2=Label Two" — replaces the curated list. */
  modelsEnv: string;
  models: CatalogModel[];
  /** Chat Completions' token cap field: reasoning-model APIs reject max_tokens. */
  maxTokensField: "max_tokens" | "max_completion_tokens";
  /** Extra request-body fields for a chosen effort (undefined: the model takes none). */
  reasoningBody?: (effort: Effort | undefined) => Record<string, unknown>;
  /**
   * Thinking models whose API needs every assistant message's
   * `reasoning_content` sent back during a tool loop (DeepSeek returns 400
   * without it; Kimi requires the full message unchanged).
   */
  replayReasoning: boolean;
}

const ALL: Effort[] = ["low", "medium", "high", "xhigh", "max"];
const LOW_HIGH_MAX: Effort[] = ["low", "high", "max"];
const LOW_MED_HIGH: Effort[] = ["low", "medium", "high"];

const reasoningEffort = (effort: Effort | undefined) => (effort ? { reasoning_effort: effort } : {});

export const PRESETS: Preset[] = [
  {
    id: "openai",
    label: "OpenAI",
    blurb: "GPT-6 Astra, 6.1 Sol, 6 Luna",
    baseURL: "https://api.openai.com/v1",
    // ANALYST_OPENAI_API_KEY already names the generic openai-compatible
    // slot (with ANALYST_OPENAI_BASE_URL); OpenAI's own key keeps its
    // standard name so existing configs mean what they meant before.
    keyEnv: ["OPENAI_API_KEY"],
    baseUrlEnv: "ANALYST_OPENAI_PLATFORM_BASE_URL",
    modelsEnv: "ANALYST_OPENAI_PLATFORM_MODELS",
    maxTokensField: "max_completion_tokens",
    reasoningBody: reasoningEffort,
    replayReasoning: false,
    models: [
      { id: "gpt-6-astra", label: "GPT-6 Astra", note: "OpenAI's most capable — hardest multi-step reads", tier: "frontier", effort: true, efforts: ALL, defaultEffort: "medium" },
      { id: "gpt-6.1-sol", label: "GPT-6.1 Sol", note: "Near-Astra quality at lower cost", tier: "balanced", effort: true, efforts: ALL, defaultEffort: "medium" },
      { id: "gpt-6-luna", label: "GPT-6 Luna", note: "Fast, cheap lookups", tier: "fast", effort: true, efforts: ALL, defaultEffort: "low" },
    ],
  },
  {
    id: "google",
    label: "Google Gemini",
    blurb: "Gemini 3.8 Flash, 3.5 Flash-Lite",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
    keyEnv: ["ANALYST_GEMINI_API_KEY", "GEMINI_API_KEY"],
    baseUrlEnv: "ANALYST_GEMINI_BASE_URL",
    modelsEnv: "ANALYST_GEMINI_MODELS",
    maxTokensField: "max_tokens",
    // reasoning_effort maps onto Gemini's thinking levels; thinking can't be
    // turned off on Gemini 3, so there is no "none".
    reasoningBody: reasoningEffort,
    replayReasoning: false,
    models: [
      { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", note: "Google's current recommended model", tier: "balanced", effort: true, efforts: LOW_MED_HIGH, defaultEffort: "medium" },
      { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite", note: "Cheapest, quick lookups", tier: "fast", effort: true, efforts: LOW_MED_HIGH, defaultEffort: "low" },
    ],
  },
  {
    id: "xai",
    label: "xAI",
    blurb: "Grok 4.7",
    baseURL: "https://api.x.ai/v1",
    keyEnv: ["ANALYST_XAI_API_KEY", "XAI_API_KEY"],
    baseUrlEnv: "ANALYST_XAI_BASE_URL",
    modelsEnv: "ANALYST_XAI_MODELS",
    maxTokensField: "max_tokens",
    replayReasoning: false,
    models: [{ id: "grok-4.7", label: "Grok 4.7", note: "xAI's flagship for agents and analysis", tier: "frontier", effort: false }],
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    blurb: "V4 Pro, V4.1 Flash",
    baseURL: "https://api.deepseek.com",
    keyEnv: ["ANALYST_DEEPSEEK_API_KEY", "DEEPSEEK_API_KEY"],
    baseUrlEnv: "ANALYST_DEEPSEEK_BASE_URL",
    modelsEnv: "ANALYST_DEEPSEEK_MODELS",
    maxTokensField: "max_tokens",
    // Thinking mode is opt-in per request; DeepSeek maps medium→high and
    // xhigh→high itself, so only its own three levels are offered.
    reasoningBody: (effort) => ({ thinking: { type: "enabled" }, reasoning_effort: effort ?? "high" }),
    replayReasoning: true,
    models: [
      { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", note: "Deep reasoning with tools, 1M context", tier: "frontier", effort: true, efforts: LOW_HIGH_MAX, defaultEffort: "high" },
      { id: "deepseek-flash", label: "DeepSeek V4.1 Flash", note: "Fast and cheap, thinking on demand", tier: "balanced", effort: true, efforts: LOW_HIGH_MAX, defaultEffort: "low" },
    ],
  },
  {
    id: "moonshot",
    label: "Moonshot Kimi",
    blurb: "Kimi K3, K2.6",
    baseURL: "https://api.moonshot.ai/v1",
    keyEnv: ["ANALYST_MOONSHOT_API_KEY", "MOONSHOT_API_KEY"],
    baseUrlEnv: "ANALYST_MOONSHOT_BASE_URL",
    modelsEnv: "ANALYST_MOONSHOT_MODELS",
    maxTokensField: "max_tokens",
    // K3 always thinks; its effort defaults to max (the priciest), so the
    // analyst sends an explicit level. K2.6 takes no effort field.
    reasoningBody: reasoningEffort,
    replayReasoning: true,
    models: [
      { id: "kimi-k3", label: "Kimi K3", note: "Moonshot's flagship, long multi-tool research", tier: "frontier", effort: true, efforts: LOW_HIGH_MAX, defaultEffort: "high" },
      { id: "kimi-k2.6", label: "Kimi K2.6", note: "Open-weight, 256K context, reasoning by default", tier: "balanced", effort: false },
    ],
  },
  {
    id: "qwen",
    label: "Alibaba Qwen",
    blurb: "Qwen3.8 Max, 3.7 Plus, 3.8 Flash",
    // International (Singapore) endpoint; set ANALYST_QWEN_BASE_URL for the
    // US/EU/China regions.
    baseURL: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    keyEnv: ["ANALYST_QWEN_API_KEY", "DASHSCOPE_API_KEY"],
    baseUrlEnv: "ANALYST_QWEN_BASE_URL",
    modelsEnv: "ANALYST_QWEN_MODELS",
    maxTokensField: "max_tokens",
    replayReasoning: false,
    models: [
      { id: "qwen3.8-max", label: "Qwen3.8 Max", note: "Alibaba's strongest Qwen", tier: "frontier", effort: false },
      { id: "qwen3.7-plus", label: "Qwen3.7 Plus", note: "Balanced cost and depth", tier: "balanced", effort: false },
      { id: "qwen3.8-flash", label: "Qwen3.8 Flash", note: "Fast, cheap lookups", tier: "fast", effort: false },
    ],
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    blurb: "Any model OpenRouter routes — list them in ANALYST_OPENROUTER_MODELS",
    baseURL: "https://openrouter.ai/api/v1",
    keyEnv: ["ANALYST_OPENROUTER_API_KEY", "OPENROUTER_API_KEY"],
    baseUrlEnv: "ANALYST_OPENROUTER_BASE_URL",
    modelsEnv: "ANALYST_OPENROUTER_MODELS",
    maxTokensField: "max_tokens",
    replayReasoning: false,
    // Slugs are vendor/model and change often; the deployment names them.
    models: [],
  },
];

export function presetById(id: string): Preset | undefined {
  return PRESETS.find((p) => p.id === id);
}

/** Parses "id,id2=Label Two,id3" into catalog entries with unknown capabilities. */
export function parseModelList(raw: string | undefined, note: string): CatalogModel[] {
  const s = raw?.trim();
  if (!s) return [];
  return s
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const eq = entry.indexOf("=");
      const id = (eq >= 0 ? entry.slice(0, eq) : entry).trim();
      const label = (eq >= 0 ? entry.slice(eq + 1) : entry).trim() || id;
      return { id, label, note, tier: "balanced" as const, effort: false };
    })
    .filter((m) => m.id.length > 0);
}

type Env = Record<string, string | undefined>;

/** The preset's key, base URL and model list as this deployment configures them. */
export function presetConfig(p: Preset, env: Env): { apiKey?: string; baseURL: string; models: CatalogModel[] } {
  const apiKey = p.keyEnv.map((k) => env[k]?.trim()).find(Boolean);
  const baseURL = env[p.baseUrlEnv]?.trim() || p.baseURL;
  const override = parseModelList(env[p.modelsEnv], `From ${p.modelsEnv}`);
  return { apiKey, baseURL, models: override.length ? override : p.models };
}
