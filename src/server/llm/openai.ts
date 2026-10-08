import type {
  Conversation,
  Effort,
  LLMProvider,
  ProviderId,
  StepHooks,
  StepOptions,
  StepResult,
  StopKind,
  ToolCall,
  ToolOutcome,
  ToolSpec,
  Turn,
} from "./provider.js";

// OpenAI-compatible Chat Completions provider: every vendor preset
// (presets.ts — OpenAI, Gemini, xAI, DeepSeek, Kimi, Qwen, OpenRouter) and
// the generic openai-compatible slot. Plain fetch + SSE parsing, no SDK.
// There is no portable hosted web search in this API shape, so the analyst
// omits web_search for these providers and says so in its tool list.
//
// Thinking models stream their reasoning as `reasoning_content` (DeepSeek,
// Kimi, Qwen) or `reasoning` (OpenRouter); it is surfaced through
// onReasoning and, for presets that require it, sent back on the
// assistant message so a tool loop keeps its chain of thought.

export interface OpenAICompatibleOptions {
  apiKey: string;
  model: string;
  baseURL: string;
  /** Which catalog entry this is (default "openai-compatible"). */
  id?: ProviderId;
  label?: string;
  /** Effort in force, for the done event (the wire shape is in extraBody). */
  effort?: Effort;
  /** Merged into every request body (reasoning controls). */
  extraBody?: Record<string, unknown>;
  maxTokensField?: "max_tokens" | "max_completion_tokens";
  /** Send reasoning_content back on assistant messages (DeepSeek, Kimi). */
  replayReasoning?: boolean;
  fetch?: typeof fetch;
  maxTokens?: number;
  /** Injected delay (tests skip real waiting). */
  retryDelay?: (ms: number, signal: AbortSignal) => Promise<void>;
}

type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: WireToolCall[]; reasoning_content?: string }
  | { role: "tool"; tool_call_id: string; content: string };

interface WireToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export class OpenAICompatibleProvider implements LLMProvider {
  readonly id: ProviderId;
  readonly label?: string;
  readonly webSearch = false;
  readonly model: string;
  readonly effort?: Effort;

  constructor(private readonly opts: OpenAICompatibleOptions) {
    this.id = opts.id ?? "openai-compatible";
    this.label = opts.label;
    this.model = opts.model;
    this.effort = opts.effort;
  }

  start(system: string, history: Turn[], question: string): Conversation {
    if (this.opts.replayReasoning && history.length > 0) {
      // These APIs expect every earlier assistant message back with its
      // reasoning_content, which the session's text-only history doesn't
      // carry; earlier turns ride in the opening user message instead.
      const transcript = history.map((t) => `${t.role === "user" ? "Operator" : "Analyst"}: ${t.content}`).join("\n\n");
      return new OpenAIConversation(this.opts, [
        { role: "system", content: system },
        { role: "user", content: `Earlier in this session:\n\n${transcript}\n\n---\n\n${question}` },
      ]);
    }
    return new OpenAIConversation(this.opts, [
      { role: "system", content: system },
      ...history.map((t) => ({ role: t.role, content: t.content }) as ChatMessage),
      { role: "user", content: question },
    ]);
  }
}

class OpenAIConversation implements Conversation {
  constructor(
    private readonly opts: OpenAICompatibleOptions,
    private readonly messages: ChatMessage[],
  ) {}

  async step(tools: ToolSpec[], hooks: StepHooks, opts: StepOptions): Promise<StepResult> {
    const doFetch = this.opts.fetch ?? fetch;
    const res = await postWithRetry429(
      doFetch,
      `${this.opts.baseURL.replace(/\/+$/, "")}/chat/completions`,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.opts.apiKey}` },
        body: JSON.stringify({
          ...this.opts.extraBody,
          model: this.opts.model,
          // Thinking models spend part of the cap on reasoning.
          [this.opts.maxTokensField ?? "max_tokens"]: this.opts.maxTokens ?? 16000,
          stream: true,
          stream_options: { include_usage: true },
          messages: this.messages,
          tools: tools.map((t) => ({
            type: "function",
            function: { name: t.name, description: t.description, parameters: t.input_schema },
          })),
          tool_choice: opts.final ? "none" : "auto",
        }),
        signal: opts.signal,
      },
      opts.signal,
      this.opts.retryDelay,
    );
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      throw new Error(`provider HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
    }

    let content = "";
    let reasoning = "";
    let finish: string | null = null;
    const calls: WireToolCall[] = [];
    const usage = { input_tokens: 0, output_tokens: 0 };

    for await (const data of sseData(res.body)) {
      if (data === "[DONE]") break;
      let chunk: ChatChunk;
      try {
        chunk = JSON.parse(data) as ChatChunk;
      } catch {
        continue;
      }
      if (chunk.usage) {
        usage.input_tokens = chunk.usage.prompt_tokens ?? usage.input_tokens;
        usage.output_tokens = chunk.usage.completion_tokens ?? usage.output_tokens;
      }
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta ?? {};
      const think = delta.reasoning_content ?? delta.reasoning;
      if (think) {
        reasoning += think;
        hooks.onReasoning?.(think);
      }
      if (delta.content) {
        content += delta.content;
        hooks.onText(delta.content);
      }
      for (const tc of delta.tool_calls ?? []) {
        const i = tc.index ?? 0;
        calls[i] ??= { id: "", type: "function", function: { name: "", arguments: "" } };
        if (tc.id) calls[i].id = tc.id;
        if (tc.function?.name) calls[i].function.name += tc.function.name;
        if (tc.function?.arguments) calls[i].function.arguments += tc.function.arguments;
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }

    const wireCalls = calls.filter(Boolean).map((c, i) => ({ ...c, id: c.id || `call_${i}` }));
    this.messages.push({
      role: "assistant",
      content: content || null,
      ...(wireCalls.length ? { tool_calls: wireCalls } : {}),
      ...(this.opts.replayReasoning && reasoning ? { reasoning_content: reasoning } : {}),
    });

    const toolCalls: ToolCall[] = wireCalls.map((c) => ({ id: c.id, name: c.function.name, input: parseArgs(c.function.arguments) }));
    return { stop: mapFinish(finish, toolCalls.length), toolCalls, usage };
  }

  addToolResults(results: ToolOutcome[]): void {
    for (const r of results) this.messages.push({ role: "tool", tool_call_id: r.id, content: r.content });
  }
}

const MAX_429_RETRIES = 3;
const MAX_429_TOTAL_MS = 20_000;

/**
 * Retries only HTTP 429 (organization rate limit / concurrency), honoring
 * Retry-After or a "try again after N seconds" hint in the body, with
 * jitter; up to MAX_429_RETRIES or MAX_429_TOTAL_MS total wait. Any other
 * status (including other 4xx) is returned as-is for the caller to handle.
 */
export async function postWithRetry429(
  doFetch: typeof fetch,
  url: string,
  init: RequestInit,
  signal: AbortSignal,
  delay: (ms: number, signal: AbortSignal) => Promise<void> = sleep,
): Promise<Response> {
  let waited = 0;
  for (let attempt = 0; ; attempt++) {
    const res = await doFetch(url, init);
    if (res.status !== 429) return res;
    const text = await res.text().catch(() => "");
    const wait = retryAfterMs(res, text) + Math.floor(Math.random() * 300);
    if (attempt >= MAX_429_RETRIES || waited + wait > MAX_429_TOTAL_MS) {
      throw new Error(`provider HTTP 429${text ? `: ${text.slice(0, 200)}` : ""}`);
    }
    await delay(wait, signal);
    waited += wait;
  }
}

function retryAfterMs(res: Response, text: string): number {
  const raw = res.headers.get("retry-after");
  const header = raw === null ? NaN : Number(raw);
  if (Number.isFinite(header) && header >= 0) return header * 1000;
  const hint = text.match(/try again after (\d+(?:\.\d+)?)\s*second/i);
  if (hint) return Number(hint[1]) * 1000;
  return 1000;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new Error("aborted"));
    });
  });
}

interface ChatChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      reasoning?: string | null;
      tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
}

function mapFinish(finish: string | null, toolCalls: number): StopKind {
  if (toolCalls > 0 && (finish === "tool_calls" || finish === "function_call" || finish === null)) return "tool_use";
  if (finish === "length") return "max_tokens";
  if (finish === "content_filter") return "refusal";
  return "end";
}

/** Arguments arrive as a JSON string; invalid JSON is passed through as {__raw} for the validator to reject. */
function parseArgs(s: string): unknown {
  if (!s.trim()) return {};
  try {
    return JSON.parse(s);
  } catch {
    return { __raw: s };
  }
}

/** Yields the `data:` payload of each SSE event in a byte stream. */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.search(/\r?\n\r?\n/)) >= 0) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx).replace(/^\r?\n\r?\n/, "");
      const data = raw
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).replace(/^ /, ""))
        .join("\n");
      if (data) yield data;
    }
  }
  const tail = buf
    .split(/\r?\n/)
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).replace(/^ /, ""))
    .join("\n");
  if (tail) yield tail;
}
