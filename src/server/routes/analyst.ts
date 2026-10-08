import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { buildSystemPrompt } from "../llm/system.js";
import { buildCatalog, type AnalystCatalog } from "../llm/catalog.js";
import {
  isProviderId,
  resolveChosenProvider,
  resolveProvider,
  type AnalystEnv,
  type Citation,
  type Effort,
  type LLMProvider,
  type ProviderId,
  type ToolOutcome,
  type ToolSpec,
  type Usage,
} from "../llm/provider.js";
import { TOOL_SPECS, defaultToolDeps, hasWebSearch, runTool, toolCatalog, type ToolDeps, type ToolRun } from "../llm/tools.js";
import { SIM_TOOL_SPEC, buildSimSystemPrompt, realSimDeps, runSimTool } from "../llm/sim.js";
import type { IntentDeps } from "../sim/intent.js";
import type { SimBranchOutcome, SimIntent } from "../../shared/intent.js";

// /analyst — the classic-LLM analyst (SPEC.md "Analyst"). Read-only: it
// reads the app's data through tools/tools.ts and never places orders; Jev
// stays the only model inside the trading loop. Session-cookie protection
// comes from the global requireAuth gate in api/index.ts.
//
// POST /analyst/query {question, history?, provider?, model?, effort?} →
//   text/event-stream:
//   event: text         {delta}
//   event: reasoning    {delta}   (thinking text the model exposes)
//   event: tool_call    {id, name, input, server}
//   event: tool_result  {id, name, ok, summary}
//   event: sim_result   {id, intent, branches}   (mode "sim" only, before that call's tool_result)
//   event: citations    {citations: [{url, title, cited_text?}]}
//   event: error        {error}
//   event: done         {usage, model, provider, label?, rounds, stop, effort?}
// GET /analyst/status → {configured, provider, model, web_search, tools}
// GET /analyst/models → {default: {provider, model}, providers: [...]}
//   (src/server/llm/catalog.ts) — always 200, even fully unconfigured.
// Unconfigured (no provider/model/effort chosen in the body) → 503
// { error: "analyst not configured" }. An explicit but invalid/unavailable
// provider, model or effort choice → 400 { error, field }.

export const TIMEOUT_MS = 90_000;
export const MAX_TOOL_ROUNDS = 8;

const QueryBody = z.object({
  question: z.string().trim().min(1).max(4000),
  mode: z.enum(["ask", "sim"]).optional(),
  history: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(20_000) }))
    .max(40)
    .optional(),
  // Optional model/provider selection (src/ui/components/analyst/ModelSelector.tsx).
  // Omitted entirely → the server default (resolveProvider), unchanged.
  provider: z.string().trim().min(1).max(40).refine(isProviderId, { message: "unknown provider" }).optional(),
  model: z.string().trim().min(1).max(200).optional(),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
});

export type AnalystEvent =
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "tool_call"; id: string; name: string; input: unknown; server: boolean }
  | { type: "tool_result"; id: string; name: string; ok: boolean; summary: string }
  | { type: "sim_result"; id: string; intent: SimIntent; branches: SimBranchOutcome[] }
  | { type: "citations"; citations: Citation[] }
  | { type: "error"; error: string }
  | { type: "done"; usage: Usage; model: string; provider: string; label?: string; rounds: number; stop: string; effort?: Effort };

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
  /** Sim mode overrides; defaults are the ask-mode prompt, TOOL_SPECS and runTool. */
  system?: string;
  tools?: ToolSpec[];
  runTool?: (call: { id: string; name: string; input: unknown }) => Promise<ToolRun>;
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
  const conv = provider.start(opts.system ?? buildSystemPrompt(hasWebSearch(provider)), opts.history ?? [], question);
  const hooks = {
    onText: (delta: string) => void emit({ type: "text", delta }),
    onReasoning: (delta: string) => void emit({ type: "reasoning", delta }),
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
      const res = await conv.step(opts.tools ?? TOOL_SPECS, hooks, { signal: ctrl.signal, final });
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
          const r = await (opts.runTool ? opts.runTool(call) : runTool(call.name, call.input, deps));
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
  await emit({ type: "done", usage, model: provider.model, provider: provider.id, label: provider.label, rounds, stop, effort: provider.effort });
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
  /** Resolves the server-default provider (no explicit choice in the body). */
  resolve?: () => LLMProvider | null;
  /** The catalog GET /models serves and POST /query validates choices against. */
  catalog?: () => AnalystCatalog;
  /** Builds a specific, already-validated provider/model/effort choice. */
  resolveChoice?: (choice: { provider: ProviderId; model: string; effort?: Effort }) => LLMProvider | null;
  deps?: ToolDeps;
  /** Sim mode's simulation deps (tests inject fixtures). Default: real backfill/candles + HL max leverage. */
  simDeps?: IntentDeps;
  timeoutMs?: number;
  maxRounds?: number;
}

export function createAnalystRoutes(o: AnalystRouteOptions = {}) {
  const catalog = o.catalog ?? (() => buildCatalog(process.env as AnalystEnv));
  const resolveChoice =
    o.resolveChoice ?? ((choice: { provider: ProviderId; model: string; effort?: Effort }) => resolveChosenProvider(process.env as AnalystEnv, choice));
  // The server default when it is configured; otherwise the first provider
  // the catalog has ready — a deployment with only, say, DEEPSEEK_API_KEY
  // set still has a working analyst without also setting ANALYST_PROVIDER.
  const resolve =
    o.resolve ??
    (() => {
      const p = resolveProvider();
      if (p) return p;
      const first = catalog().providers.find((e) => e.available && e.models.length > 0);
      if (!first) return null;
      const m = first.models[0]!;
      return resolveChoice({ provider: first.id, model: m.id, effort: m.defaultEffort });
    });
  return new Hono()
    .get("/status", (c) => {
      const p = resolve();
      if (!p) return c.json({ configured: false, error: "analyst not configured" }, 503);
      return c.json({ configured: true, provider: p.id, label: p.label ?? p.id, model: p.model, web_search: hasWebSearch(p), tools: toolCatalog(hasWebSearch(p)) });
    })
    .get("/models", (c) => c.json(catalog()))
    .post("/query", async (c) => {
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: "invalid JSON body" }, 400);
      }
      const parsed = QueryBody.safeParse(body);
      if (!parsed.success) return c.json({ error: "invalid query", field: parsed.error.issues[0]?.path.join(".") }, 400);

      let provider: LLMProvider | null;
      const { provider: reqProvider, model: reqModel, effort: reqEffort } = parsed.data;
      if (reqProvider !== undefined || reqModel !== undefined || reqEffort !== undefined) {
        // An explicit choice: validate it against the catalog (400 with the
        // offending field on failure) rather than falling back silently.
        const cat = catalog();
        const providerId = reqProvider ?? cat.default.provider;
        const entry = cat.providers.find((p) => p.id === providerId);
        if (!entry || !entry.available) {
          return c.json({ error: entry?.reason ?? `provider ${providerId} is not available`, field: "provider" }, 400);
        }
        const modelId = reqModel ?? (providerId === cat.default.provider ? cat.default.model : entry.models[0]?.id);
        const modelEntry = modelId ? entry.models.find((m) => m.id === modelId) : undefined;
        if (!modelEntry) {
          return c.json({ error: `unknown model ${JSON.stringify(modelId ?? null)} for provider ${providerId}`, field: "model" }, 400);
        }
        if (reqEffort !== undefined && !modelEntry.effort) {
          return c.json({ error: `${modelEntry.id} does not support an effort level`, field: "effort" }, 400);
        }
        if (reqEffort !== undefined && modelEntry.efforts && !modelEntry.efforts.includes(reqEffort)) {
          return c.json({ error: `${modelEntry.id} takes effort ${modelEntry.efforts.join("/")}`, field: "effort" }, 400);
        }
        provider = resolveChoice({ provider: providerId, model: modelEntry.id, effort: reqEffort ?? modelEntry.defaultEffort });
        if (!provider) return c.json({ error: entry.reason ?? `provider ${providerId} is not configured`, field: "provider" }, 400);
      } else {
        provider = resolve();
        if (!provider) return c.json({ error: "analyst not configured" }, 503);
      }

      c.header("cache-control", "no-store");
      c.header("x-accel-buffering", "no");
      return streamSSE(c, async (stream) => {
        const disconnect = new AbortController();
        stream.onAbort(() => disconnect.abort());
        const emit = async (e: AnalystEvent) => {
          if (disconnect.signal.aborted) return;
          const { type, ...data } = e;
          await stream.writeSSE({ event: type, data: JSON.stringify(data) });
        };
        let sim: Pick<RunOptions, "system" | "tools" | "runTool"> = {};
        if (parsed.data.mode === "sim") {
          const simDeps = o.simDeps ?? (await realSimDeps());
          const toolDeps = o.deps ?? defaultToolDeps;
          sim = {
            system: buildSimSystemPrompt(hasWebSearch(provider)),
            tools: [...TOOL_SPECS, SIM_TOOL_SPEC],
            runTool: (call) => (call.name === SIM_TOOL_SPEC.name ? runSimTool(call, simDeps, emit) : runTool(call.name, call.input, toolDeps)),
          };
        }
        await runAnalyst(
          {
            provider,
            ...sim,
            question: parsed.data.question,
            history: parsed.data.history,
            deps: o.deps,
            timeoutMs: o.timeoutMs,
            maxRounds: o.maxRounds,
            signal: disconnect.signal,
          },
          emit,
        );
      });
    });
}

export const analystRoutes = createAnalystRoutes();
