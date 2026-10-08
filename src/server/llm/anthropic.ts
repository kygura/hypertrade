import Anthropic from "@anthropic-ai/sdk";
import type {
  Citation,
  Conversation,
  Effort,
  LLMProvider,
  StepHooks,
  StepOptions,
  StepResult,
  StopKind,
  ToolCall,
  ToolOutcome,
  ToolSpec,
  Turn,
} from "./provider.js";

// Anthropic Messages API provider (official SDK, streaming). Client tools
// are the analyst's read-only data tools; web search is Anthropic's
// server-side tool, so its calls and results arrive inside the same
// response and are surfaced to the UI through the server-tool hooks.
//
// Per model (claude-api skill, 2026-09-25):
// - Fable 5.1 / Opus 5.5 / Sonnet 5.5 take output_config.effort and
//   adaptive thinking; thinking display is set to "summarized" so the UI's
//   reasoning panel has text (the default, "omitted", streams empty blocks).
//   They also get server-side refusal fallbacks ("default" routing) on the
//   first-party API: a safety decline re-runs on a fallback model inside
//   the same call instead of ending the answer.
// - Haiku 4.5 takes neither effort nor adaptive thinking, and only the
//   basic web_search_20250305 tool.
// The request goes through the beta namespace because fallbacks are beta.

export interface AnthropicProviderOptions {
  apiKey: string;
  model: string;
  baseURL?: string;
  effort?: Effort;
  /** Injected transport (tests). */
  fetch?: typeof fetch;
  maxTokens?: number;
  webSearchMaxUses?: number;
}

/** Models on the current generation's surface (effort, adaptive thinking, new web search). */
export function isCurrentGen(model: string): boolean {
  return !model.startsWith("claude-haiku");
}

/** Models whose first-party API takes `fallbacks: "default"`. */
const FALLBACK_MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-opus-5"]);
export const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export class AnthropicProvider implements LLMProvider {
  readonly id = "anthropic" as const;
  readonly label = "Anthropic";
  readonly webSearch = true;
  readonly model: string;
  /** Effort actually in force — defaults to "medium"; undefined for models that take none. */
  readonly effort?: Effort;
  private readonly client: Anthropic;
  private readonly opts: AnthropicProviderOptions;

  constructor(opts: AnthropicProviderOptions) {
    this.opts = opts;
    this.model = opts.model;
    this.effort = isCurrentGen(opts.model) ? (opts.effort ?? "medium") : undefined;
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      baseURL: opts.baseURL,
      fetch: opts.fetch,
      // The analyst route owns the overall 90 s budget and aborts via the
      // signal; one SDK retry covers a transient 429/5xx inside it.
      maxRetries: 1,
    });
  }

  start(system: string, history: Turn[], question: string): Conversation {
    return new AnthropicConversation(this.client, { ...this.opts, effort: this.effort }, system, history, question);
  }
}

class AnthropicConversation implements Conversation {
  private readonly messages: Anthropic.Beta.BetaMessageParam[];

  constructor(
    private readonly client: Anthropic,
    private readonly opts: AnthropicProviderOptions,
    private readonly system: string,
    history: Turn[],
    question: string,
  ) {
    this.messages = [...history.map((t) => ({ role: t.role, content: t.content })), { role: "user", content: question }];
  }

  async step(tools: ToolSpec[], hooks: StepHooks, opts: StepOptions): Promise<StepResult> {
    const model = this.opts.model;
    const current = isCurrentGen(model);
    const apiTools: Anthropic.Beta.BetaToolUnion[] = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
    }));
    // When the caller already offers its own web_search (the Exa tool,
    // EXA_API_KEY set), defer to it instead of also registering Anthropic's
    // native hosted tool under the same name — the API rejects duplicates.
    if (!tools.some((t) => t.name === "web_search")) {
      apiTools.push(
        current
          ? { type: "web_search_20260209", name: "web_search", max_uses: this.opts.webSearchMaxUses ?? 5 }
          : { type: "web_search_20250305", name: "web_search", max_uses: this.opts.webSearchMaxUses ?? 5 },
      );
    }
    // "default" fallback routing is first-party only: skip it behind a base-URL override.
    const fallbacks = FALLBACK_MODELS.has(model) && !this.opts.baseURL;

    const stream = this.client.beta.messages.stream(
      {
        model,
        max_tokens: this.opts.maxTokens ?? 16000,
        // Frozen system prompt first so the prefix caches across turns.
        system: [{ type: "text", text: this.system, cache_control: { type: "ephemeral" } }],
        messages: this.messages,
        tools: apiTools,
        // Forced tool use is unsupported on current models; the final round
        // uses "none" so the model answers from what it already gathered.
        tool_choice: opts.final ? { type: "none" } : { type: "auto" },
        ...(current
          ? { thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: this.opts.effort ?? "medium" } }
          : {}),
        ...(fallbacks ? { betas: [FALLBACK_BETA], fallbacks: "default" } : {}),
      },
      { signal: opts.signal },
    );

    stream.on("thinking", (delta) => hooks.onReasoning?.(delta));
    stream.on("text", (delta) => hooks.onText(delta));
    stream.on("contentBlock", (block) => {
      if (block.type === "server_tool_use") {
        hooks.onServerToolCall?.({ id: block.id, name: block.name, input: block.input });
      } else if (block.type === "web_search_tool_result") {
        const { ok, summary } = summarizeWebSearch(block.content);
        hooks.onServerToolResult?.(block.tool_use_id, "web_search", ok, summary);
      } else if (block.type === "text" && block.citations) {
        for (const c of block.citations) {
          if (c.type === "web_search_result_location") {
            hooks.onCitation?.({ url: c.url, title: c.title, cited_text: c.cited_text });
          }
        }
      }
    });

    const message = await stream.finalMessage();
    // Append the full content (tool_use, server tool blocks, citations) so
    // the next request continues the same turn faithfully.
    this.messages.push({ role: "assistant", content: message.content });

    const toolCalls: ToolCall[] = message.content
      .filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use")
      .map((b) => ({ id: b.id, name: b.name, input: b.input }));

    return {
      stop: mapStop(message.stop_reason, toolCalls.length),
      toolCalls,
      usage: { input_tokens: message.usage.input_tokens, output_tokens: message.usage.output_tokens },
    };
  }

  addToolResults(results: ToolOutcome[]): void {
    // All results of one assistant turn go back in a single user message.
    this.messages.push({
      role: "user",
      content: results.map((r) => ({
        type: "tool_result" as const,
        tool_use_id: r.id,
        content: r.content,
        is_error: r.isError || undefined,
      })),
    });
  }
}

function mapStop(reason: Anthropic.Beta.BetaStopReason | null, toolCalls: number): StopKind {
  switch (reason) {
    case "tool_use":
      return toolCalls > 0 ? "tool_use" : "end";
    case "max_tokens":
      return "max_tokens";
    case "refusal":
      return "refusal";
    case "pause_turn":
      return "pause";
    default:
      return "end";
  }
}

/** Web search results are a list on success and an error object otherwise. */
export function summarizeWebSearch(content: Anthropic.Beta.BetaWebSearchToolResultBlockContent): { ok: boolean; summary: string } {
  if (!Array.isArray(content)) {
    return { ok: false, summary: `web search error: ${content.error_code}` };
  }
  const titles = content
    .slice(0, 5)
    .map((r) => r.title)
    .filter(Boolean);
  return { ok: true, summary: `${content.length} results${titles.length ? `: ${titles.join(" · ")}` : ""}` };
}

export type { Citation };
