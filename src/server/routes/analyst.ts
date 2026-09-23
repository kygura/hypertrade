import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { buildSystemPrompt } from "../llm/system";
import { resolveProvider, type Citation, type LLMProvider, type ToolOutcome, type Usage } from "../llm/provider";
import { TOOL_SPECS, defaultToolDeps, runTool, toolCatalog, type ToolDeps } from "../llm/tools";

// /analyst — the classic-LLM analyst (SPEC.md "Analyst"). Read-only: it
// reads the app's data through tools/tools.ts and never places orders; Jev
// stays the only model inside the trading loop. Session-cookie protection
// comes from the global requireAuth gate in api/index.ts.
//
// POST /analyst/query {question, history?} → text/event-stream:
//   event: text         {delta}
//   event: tool_call    {id, name, input, server}
//   event: tool_result  {id, name, ok, summary}
//   event: citations    {citations: [{url, title, cited_text?}]}
//   event: error        {error}
//   event: done         {usage, model, provider, rounds, stop}
// GET /analyst/status → {configured, provider, model, web_search, tools}
// Unconfigured → 503 { error: "analyst not configured" }.

export const TIMEOUT_MS = 90_000;
export const MAX_TOOL_ROUNDS = 8;

const QueryBody = z.object({
  question: z.string().trim().min(1).max(4000),
  history: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(20_000) }))
    .max(40)
    .optional(),
});

export type AnalystEvent =
  | { type: "text"; delta: string }
  | { type: "tool_call"; id: string; name: string; input: unknown; server: boolean }
  | { type: "tool_result"; id: string; name: string; ok: boolean; summary: string }
  | { type: "citations"; citations: Citation[] }
  | { type: "error"; error: string }
  | { type: "done"; usage: Usage; model: string; provider: string; rounds: number; stop: string };

export interface RunOptions {
  provider: LLMProvider;
  question: string;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  deps?: ToolDeps;
  timeoutMs?: number;
  maxRounds?: number;
  now?: () => Date;
  /** Aborts from outside (client disconnect). */
  signal?: AbortSignal;
}

/**
 * The analyst loop: up to maxRounds tool rounds, then one final round with
 * tools disabled. Emits events as they happen; always ends with `done`.
 */
export async function runAnalyst(opts: RunOptions, emit: (e: AnalystEvent) => Promise<void> | void): Promise<void> {
  const { provider } = opts;
  const deps = opts.deps ?? defaultToolDeps;
  const maxRounds = opts.maxRounds ?? MAX_TOOL_ROUNDS;
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, opts.timeoutMs ?? TIMEOUT_MS);
  const onOuterAbort = () => ctrl.abort();
  opts.signal?.addEventListener("abort", onOuterAbort);

  const usage: Usage = { input_tokens: 0, output_tokens: 0 };
  const citations: Citation[] = [];
  const seen = new Set<string>();
  let rounds = 0;
  let stop = "end";

  const now = (opts.now ?? (() => new Date()))();
  const question = `[current time ${now.toISOString()}]\n${opts.question}`;
  const conv = provider.start(buildSystemPrompt(provider.webSearch), opts.history ?? [], question);
  const hooks = {
    onText: (delta: string) => void emit({ type: "text", delta }),
    onServerToolCall: (c: { id: string; name: string; input: unknown }) =>
      void emit({ type: "tool_call", id: c.id, name: c.name, input: c.input, server: true }),
    onServerToolResult: (id: string, name: string, ok: boolean, summary: string) =>
      void emit({ type: "tool_result", id, name, ok, summary }),
    onCitation: (c: Citation) => {
      if (!seen.has(c.url)) {
        seen.add(c.url);
        citations.push(c);
      }
    },
  };

  try {
    for (;;) {
      const final = rounds >= maxRounds;
      const res = await conv.step(TOOL_SPECS, hooks, { signal: ctrl.signal, final });
      usage.input_tokens += res.usage.input_tokens;
      usage.output_tokens += res.usage.output_tokens;
      if (res.stop === "pause") {
        // Provider-hosted tool paused a long turn; continue it.
        if (final) break;
        rounds++;
        continue;
      }
      if (res.stop !== "tool_use" || res.toolCalls.length === 0) {
        stop = res.stop;
        if (res.stop === "refusal") await emit({ type: "error", error: "the model declined this request" });
        if (res.stop === "max_tokens") await emit({ type: "error", error: "answer truncated at the output limit" });
        break;
      }
      if (final) {
        stop = "max_rounds";
        break;
      }
      rounds++;
      for (const call of res.toolCalls) {
        await emit({ type: "tool_call", id: call.id, name: call.name, input: call.input, server: false });
      }
      const results: ToolOutcome[] = await Promise.all(
        res.toolCalls.map(async (call) => {
          const r = await runTool(call.name, call.input, deps);
          await emit({ type: "tool_result", id: call.id, name: call.name, ok: !r.isError, summary: r.summary });
          return { id: call.id, name: call.name, content: r.content, isError: r.isError };
        }),
      );
      conv.addToolResults(results);
    }
  } catch (err) {
    if (timedOut) {
      stop = "timeout";
      await emit({ type: "error", error: `analyst timeout after ${Math.round((opts.timeoutMs ?? TIMEOUT_MS) / 1000)}s` });
    } else if (ctrl.signal.aborted) {
      stop = "aborted";
    } else {
      stop = "error";
      await emit({ type: "error", error: providerError(err) });
    }
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onOuterAbort);
  }
  if (citations.length) await emit({ type: "citations", citations });
  await emit({ type: "done", usage, model: provider.model, provider: provider.id, rounds, stop });
}

/** Provider failures without leaking request details (keys never appear here). */
function providerError(err: unknown): string {
  if (err && typeof err === "object" && "status" in err && typeof (err as { status: unknown }).status === "number") {
    const status = (err as { status: number }).status;
    if (status === 401 || status === 403) return "analyst provider rejected the credentials";
    if (status === 429) return "analyst provider is rate limiting; try again shortly";
    return `analyst provider error (HTTP ${status})`;
  }
  const msg = err instanceof Error ? err.message : String(err);
  return `analyst provider error: ${msg.slice(0, 200)}`;
}

export interface AnalystRouteOptions {
  resolve?: () => LLMProvider | null;
  deps?: ToolDeps;
  timeoutMs?: number;
  maxRounds?: number;
}

export function createAnalystRoutes(o: AnalystRouteOptions = {}) {
  const resolve = o.resolve ?? (() => resolveProvider());
  return new Hono()
    .get("/status", (c) => {
      const p = resolve();
      if (!p) return c.json({ configured: false, error: "analyst not configured" }, 503);
      return c.json({ configured: true, provider: p.id, model: p.model, web_search: p.webSearch, tools: toolCatalog(p.webSearch) });
    })
    .post("/query", async (c) => {
      const provider = resolve();
      if (!provider) return c.json({ error: "analyst not configured" }, 503);
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: "invalid JSON body" }, 400);
      }
      const parsed = QueryBody.safeParse(body);
      if (!parsed.success) return c.json({ error: "invalid query", field: parsed.error.issues[0]?.path.join(".") }, 400);

      c.header("cache-control", "no-store");
      c.header("x-accel-buffering", "no");
      return streamSSE(c, async (stream) => {
        const disconnect = new AbortController();
        stream.onAbort(() => disconnect.abort());
        await runAnalyst(
          {
            provider,
            question: parsed.data.question,
            history: parsed.data.history,
            deps: o.deps,
            timeoutMs: o.timeoutMs,
            maxRounds: o.maxRounds,
            signal: disconnect.signal,
          },
          async (e) => {
            if (disconnect.signal.aborted) return;
            const { type, ...data } = e;
            await stream.writeSSE({ event: type, data: JSON.stringify(data) });
          },
        );
      });
    });
}

export const analystRoutes = createAnalystRoutes();
