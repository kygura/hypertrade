import type {
  Conversation,
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

// OpenAI-compatible Chat Completions provider (any server exposing
// POST {base}/chat/completions with streaming function calls: a gateway,
// a local model server, another vendor). Plain fetch + SSE parsing, no SDK.
// There is no portable hosted web search in this API shape, so the analyst
// omits web_search for this provider and says so in its tool list.

export interface OpenAICompatibleOptions {
  apiKey: string;
  model: string;
  baseURL: string;
  fetch?: typeof fetch;
  maxTokens?: number;
}

type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: WireToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

interface WireToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export class OpenAICompatibleProvider implements LLMProvider {
  readonly id = "openai-compatible" as const;
  readonly webSearch = false;
  readonly model: string;

  constructor(private readonly opts: OpenAICompatibleOptions) {
    this.model = opts.model;
  }

  start(system: string, history: Turn[], question: string): Conversation {
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
    const res = await doFetch(`${this.opts.baseURL.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.opts.apiKey}` },
      body: JSON.stringify({
        model: this.opts.model,
        max_tokens: this.opts.maxTokens ?? 8000,
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
    });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      throw new Error(`provider HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
    }

    let content = "";
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
    this.messages.push({ role: "assistant", content: content || null, ...(wireCalls.length ? { tool_calls: wireCalls } : {}) });

    const toolCalls: ToolCall[] = wireCalls.map((c) => ({ id: c.id, name: c.function.name, input: parseArgs(c.function.arguments) }));
    return { stop: mapFinish(finish, toolCalls.length), toolCalls, usage };
  }

  addToolResults(results: ToolOutcome[]): void {
    for (const r of results) this.messages.push({ role: "tool", tool_call_id: r.id, content: r.content });
  }
}

interface ChatChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
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
