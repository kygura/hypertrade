// Provider-neutral contract for the analyst (SPEC.md "Analyst"). The
// analyst loop (routes/analyst.ts) drives a Conversation step by step and
// never sees provider wire formats; each provider owns its own message
// history so tool results can be appended in its native shape.
//
// The analyst is read-only market intelligence. It has no tool that places,
// approves or rejects anything; Jev stays the only model inside the trading
// loop (hyperion docs/jev/SPEC.md).

import { AnthropicProvider } from "./anthropic";
import { OpenAICompatibleProvider } from "./openai";

export const DEFAULT_MODEL = "claude-opus-5-5";

export type ProviderId = "anthropic" | "openai-compatible";

/** A prior turn of the session, as the UI keeps it (text only). */
export interface Turn {
  role: "user" | "assistant";
  content: string;
}

/** JSON-Schema tool definition shared by both providers. */
export interface ToolSpec {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ToolOutcome {
  id: string;
  name: string;
  content: string;
  isError: boolean;
}

export interface Citation {
  url: string;
  title: string | null;
  cited_text?: string;
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
}

export type StopKind = "end" | "tool_use" | "max_tokens" | "refusal" | "pause";

export interface StepResult {
  stop: StopKind;
  toolCalls: ToolCall[];
  usage: Usage;
}

/** Callbacks a provider fires while one step streams. */
export interface StepHooks {
  onText(delta: string): void;
  /** Provider-hosted tools (Anthropic web search): call made. */
  onServerToolCall?(call: ToolCall): void;
  /** Provider-hosted tools: result arrived (already summarised). */
  onServerToolResult?(id: string, name: string, ok: boolean, summary: string): void;
  onCitation?(c: Citation): void;
}

export interface StepOptions {
  signal: AbortSignal;
  /** Last round: the model must answer without calling tools. */
  final?: boolean;
}

export interface Conversation {
  step(tools: ToolSpec[], hooks: StepHooks, opts: StepOptions): Promise<StepResult>;
  addToolResults(results: ToolOutcome[]): void;
}

export interface LLMProvider {
  id: ProviderId;
  model: string;
  /** Whether the provider hosts a web search tool the analyst can use. */
  webSearch: boolean;
  /** Reasoning effort actually in force (anthropic only; catalog.ts). */
  effort?: Effort;
  start(system: string, history: Turn[], question: string): Conversation;
}

export interface AnalystEnv {
  ANALYST_PROVIDER?: string;
  ANALYST_MODEL?: string;
  ANALYST_API_KEY?: string;
  ANALYST_BASE_URL?: string;
  ANALYST_EFFORT?: string;
  /**
   * Anthropic-specific key. Lets anthropic be configured alongside
   * openai-compatible even when it is not ANALYST_PROVIDER's default (see
   * resolveProvider/anthropicCredentials below and catalog.ts).
   */
  ANALYST_ANTHROPIC_API_KEY?: string;
  /** openai-compatible-specific key/base URL, same purpose as above. */
  ANALYST_OPENAI_API_KEY?: string;
  ANALYST_OPENAI_BASE_URL?: string;
  /**
   * openai-compatible's selectable model catalog: "id,id2=Label Two,id3"
   * (comma-separated ids, optional "id=Label" pairs). See catalog.ts.
   */
  ANALYST_MODELS?: string;
}

/**
 * The provider ANALYST_PROVIDER names (default "anthropic"), or "unknown"
 * for an unrecognised value — mirrors the pre-multi-provider behaviour
 * where an unrecognised ANALYST_PROVIDER left the analyst unconfigured.
 */
function rawProviderKind(env: AnalystEnv): ProviderId | "unknown" {
  const kind = (env.ANALYST_PROVIDER ?? "anthropic").trim().toLowerCase() || "anthropic";
  if (kind === "anthropic") return "anthropic";
  if (kind === "openai-compatible" || kind === "openai") return "openai-compatible";
  return "unknown";
}

/**
 * Anthropic credentials, precedence order:
 *   1. ANALYST_ANTHROPIC_API_KEY — works whether or not anthropic is the
 *      server default, so both providers can be configured at once.
 *   2. ANALYST_API_KEY — only when ANALYST_PROVIDER selects anthropic (the
 *      legacy single-provider setting, unchanged).
 * Base URL only ever comes from the legacy ANALYST_BASE_URL, and only when
 * anthropic is the default provider — there is no dedicated
 * ANALYST_ANTHROPIC_BASE_URL (anthropic's own endpoint needs no override in
 * the common case).
 */
export function anthropicCredentials(env: AnalystEnv): { apiKey?: string; baseURL?: string } {
  const isDefault = rawProviderKind(env) === "anthropic";
  const apiKey = env.ANALYST_ANTHROPIC_API_KEY?.trim() || (isDefault ? env.ANALYST_API_KEY?.trim() : undefined) || undefined;
  const baseURL = (isDefault ? env.ANALYST_BASE_URL?.trim() : undefined) || undefined;
  return { apiKey, baseURL };
}

/**
 * openai-compatible credentials, precedence order:
 *   1. ANALYST_OPENAI_API_KEY / ANALYST_OPENAI_BASE_URL — works whether or
 *      not openai-compatible is the server default.
 *   2. ANALYST_API_KEY / ANALYST_BASE_URL — only when ANALYST_PROVIDER
 *      selects openai-compatible (the legacy single-provider setting).
 */
export function openaiCredentials(env: AnalystEnv): { apiKey?: string; baseURL?: string } {
  const isDefault = rawProviderKind(env) === "openai-compatible";
  const apiKey = env.ANALYST_OPENAI_API_KEY?.trim() || (isDefault ? env.ANALYST_API_KEY?.trim() : undefined) || undefined;
  const baseURL = env.ANALYST_OPENAI_BASE_URL?.trim() || (isDefault ? env.ANALYST_BASE_URL?.trim() : undefined) || undefined;
  return { apiKey, baseURL };
}

/**
 * Builds the server-default provider, or null when it is not configured
 * (no key, or openai-compatible without a base URL, or an unrecognised
 * ANALYST_PROVIDER). Keys stay server-side: they are read here and never
 * serialised to a client. For a specific provider/model/effort chosen by a
 * request, see resolveChosenProvider (catalog.ts validates the choice
 * first).
 */
export function resolveProvider(env: AnalystEnv = process.env as AnalystEnv): LLMProvider | null {
  const raw = rawProviderKind(env);
  if (raw === "anthropic") {
    const { apiKey, baseURL } = anthropicCredentials(env);
    if (!apiKey) return null;
    const model = env.ANALYST_MODEL?.trim() || DEFAULT_MODEL;
    return new AnthropicProvider({ apiKey, model, baseURL, effort: parseEffort(env.ANALYST_EFFORT) });
  }
  if (raw === "openai-compatible") {
    const { apiKey, baseURL } = openaiCredentials(env);
    if (!apiKey || !baseURL) return null;
    const model = env.ANALYST_MODEL?.trim() || DEFAULT_MODEL;
    return new OpenAICompatibleProvider({ apiKey, model, baseURL });
  }
  return null;
}

/**
 * Builds the explicit provider/model/effort a request chose (validated
 * against the catalog by the caller — routes/analyst.ts). Unlike
 * resolveProvider this is not gated by ANALYST_PROVIDER: anthropic can be
 * chosen via ANALYST_ANTHROPIC_API_KEY even when openai-compatible is the
 * server default, and vice versa.
 */
export function resolveChosenProvider(
  env: AnalystEnv,
  choice: { provider: ProviderId; model: string; effort?: Effort },
): LLMProvider | null {
  if (choice.provider === "anthropic") {
    const { apiKey, baseURL } = anthropicCredentials(env);
    if (!apiKey) return null;
    return new AnthropicProvider({ apiKey, model: choice.model, baseURL, effort: choice.effort ?? parseEffort(env.ANALYST_EFFORT) });
  }
  const { apiKey, baseURL } = openaiCredentials(env);
  if (!apiKey || !baseURL) return null;
  return new OpenAICompatibleProvider({ apiKey, model: choice.model, baseURL });
}

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export function parseEffort(v: string | undefined): Effort {
  const e = v?.trim().toLowerCase();
  return e === "low" || e === "medium" || e === "high" || e === "xhigh" || e === "max" ? e : "medium";
}
