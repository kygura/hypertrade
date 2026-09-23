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
  start(system: string, history: Turn[], question: string): Conversation;
}

export interface AnalystEnv {
  ANALYST_PROVIDER?: string;
  ANALYST_MODEL?: string;
  ANALYST_API_KEY?: string;
  ANALYST_BASE_URL?: string;
  ANALYST_EFFORT?: string;
}

/**
 * Builds the configured provider, or null when the analyst is not
 * configured (no API key, or openai-compatible without a base URL). Keys
 * stay server-side: they are read here and never serialised to a client.
 */
export function resolveProvider(env: AnalystEnv = process.env as AnalystEnv): LLMProvider | null {
  const kind = (env.ANALYST_PROVIDER ?? "anthropic").trim().toLowerCase() || "anthropic";
  const apiKey = env.ANALYST_API_KEY?.trim();
  if (!apiKey) return null;
  const model = env.ANALYST_MODEL?.trim() || DEFAULT_MODEL;
  if (kind === "anthropic") {
    return new AnthropicProvider({
      apiKey,
      model,
      baseURL: env.ANALYST_BASE_URL?.trim() || undefined,
      effort: parseEffort(env.ANALYST_EFFORT),
    });
  }
  if (kind === "openai-compatible" || kind === "openai") {
    const baseURL = env.ANALYST_BASE_URL?.trim();
    if (!baseURL) return null;
    return new OpenAICompatibleProvider({ apiKey, model, baseURL });
  }
  return null;
}

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

function parseEffort(v: string | undefined): Effort {
  const e = v?.trim().toLowerCase();
  return e === "low" || e === "medium" || e === "high" || e === "xhigh" || e === "max" ? e : "medium";
}
