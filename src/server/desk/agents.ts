import { z } from "zod";
import { buildCatalog } from "../llm/catalog.js";
import {
  isProviderId,
  resolveChosenProvider,
  resolveProvider,
  type AnalystEnv,
  type Citation,
  type Effort,
  type LLMProvider,
  type ToolOutcome,
  type ToolSpec,
  type Usage,
} from "../llm/provider.js";
import { hasWebSearch } from "../llm/tools.js";
import { pmSystem, spawnedSystem, SPECIALISTS, specialistSystem, cycleTask } from "./prompts.js";
import type { DeskService } from "./service.js";
import { ACTION_TOOLS, ALL_READ_TOOLS, READ_TOOL_NAMES, type DeskTool, type ToolContext, type ToolRun } from "./tools.js";
import type { DeskEvent } from "./types.js";

// The agent team. One loop (runAgent) drives any agent over the analyst's
// provider-neutral Conversation (src/server/llm/provider.ts), so the desk
// runs on whichever model the operator configured. The PM gets two extra
// tools that start other agents:
//
//   consult_specialists — runs roster specialists in parallel, returns reports
//   spawn_agent         — an ad-hoc analyst with a mandate and a subset of the
//                         read tools (never action tools; it cannot spawn)
//
// Only the PM holds action tools, and only when the run allows acting.
// Budgets: agents per run, rounds per agent, one wall-clock deadline.

export const PM_MAX_ROUNDS = 10;
export const SPECIALIST_MAX_ROUNDS = 6;
export const MAX_AGENTS_PER_RUN = 8;
export const MAX_SPAWNS_PER_RUN = 3;

export type ProviderRole = "pm" | "specialist";
export type ProviderFactory = (role: ProviderRole) => LLMProvider | null;

/** $/MTok (input, output) for cost estimates; unknown models report null. */
const PRICES: Record<string, [number, number]> = {
  "claude-fable-5-1": [10, 50],
  "claude-opus-5-5": [4, 20],
  "claude-opus-5": [5, 25],
  "claude-sonnet-5-5": [2, 10],
  "claude-haiku-4-5": [1, 5],
};

export function estimateCost(byModel: Map<string, Usage>): number | null {
  let total = 0;
  for (const [model, u] of byModel) {
    const p = PRICES[model];
    if (!p) return null;
    total += (u.input_tokens * p[0] + u.output_tokens * p[1]) / 1e6;
  }
  return Math.round(total * 10_000) / 10_000;
}

/**
 * Providers for the desk: the PM runs the analyst's configuration as-is
 * (any vendor, DESK_ANALYST_MODEL — same model the interactive analyst
 * uses). Scouts run on the same provider by default, with DESK_SCOUT_MODEL
 * overriding the model; DESK_SCOUT_PROVIDER additionally moves scouts to a
 * different provider (e.g. one with web search). When the scout provider
 * can't resolve (no key, unknown model/provider), scouts fall back to the
 * analyst's provider and a warning is logged once.
 */
export function deskProviderFactory(env: AnalystEnv = process.env as AnalystEnv): ProviderFactory {
  let warnedScout = false;
  return (role) => {
    let base = resolveProvider(env);
    if (!base) {
      const first = buildCatalog(env).providers.find((p) => p.available && p.models.length > 0);
      if (!first) return null;
      base = resolveChosenProvider(env, { provider: first.id, model: first.models[0]!.id, effort: first.models[0]!.defaultEffort });
      if (!base) return null;
    }
    if (role === "pm") return resolveChosenProvider(env, { provider: base.id, model: base.model, effort: "high" }) ?? base;

    const effort: Effort = "medium";
    const scoutModel = env.DESK_SCOUT_MODEL?.trim();
    const scoutProviderId = env.DESK_SCOUT_PROVIDER?.trim();
    if (scoutProviderId) {
      const model = scoutModel || buildCatalog(env).providers.find((p) => p.id === scoutProviderId)?.models[0]?.id;
      const scout = model && isProviderId(scoutProviderId) ? resolveChosenProvider(env, { provider: scoutProviderId, model, effort }) : null;
      if (scout) return scout;
      if (!warnedScout) {
        warnedScout = true;
        console.warn(`[desk] DESK_SCOUT_PROVIDER=${scoutProviderId} could not resolve (unknown provider, no key, or unknown model) — scouts fall back to the analyst's provider`);
      }
    }
    return resolveChosenProvider(env, { provider: base.id, model: scoutModel || base.model, effort }) ?? base;
  };
}

interface RunState {
  service: DeskService;
  runId: string | null;
  emit(e: DeskEvent): void;
  makeProvider: ProviderFactory;
  signal: AbortSignal;
  budget: ToolContext["budget"];
  agents: number;
  spawns: number;
  usage: Map<string, Usage>;
  citations: Map<string, Citation>;
}

export interface AgentResult {
  text: string;
  stop: string;
  rounds: number;
}

interface AgentSpec {
  id: string;
  role: string;
  parent: string | null;
  system: string;
  tools: DeskTool[];
  /** Extra tools handled by the caller (the PM's orchestration tools). */
  extra?: { specs: ToolSpec[]; run(name: string, input: unknown): Promise<ToolRun> | null };
  maxRounds: number;
  provider: LLMProvider;
}

/** One agent's tool loop. Never throws: failures end the agent with stop "error". */
export async function runAgent(spec: AgentSpec, task: string, st: RunState): Promise<AgentResult> {
  st.emit({ type: "agent_start", agent: spec.id, role: spec.role, parent: spec.parent, task, model: spec.provider.model });
  const conv = spec.provider.start(spec.system, [], task);
  const specs = [...spec.tools.map((t) => t.spec), ...(spec.extra?.specs ?? [])];
  const byName = new Map(spec.tools.map((t) => [t.spec.name, t]));
  const ctx: ToolContext = { service: st.service, runId: st.runId, agent: spec.id, emit: st.emit, budget: st.budget };
  let text = "";
  let rounds = 0;
  let stop = "end";
  const hooks = {
    onText: (delta: string) => {
      text += delta;
      st.emit({ type: "text", agent: spec.id, delta });
    },
    onReasoning: (delta: string) => st.emit({ type: "reasoning", agent: spec.id, delta }),
    onServerToolCall: (c: { id: string; name: string; input: unknown }) => st.emit({ type: "tool_call", agent: spec.id, id: c.id, name: c.name, input: c.input, server: true }),
    onServerToolResult: (id: string, name: string, ok: boolean, summary: string) => st.emit({ type: "tool_result", agent: spec.id, id, name, ok, summary }),
    onCitation: (c: Citation) => {
      if (!st.citations.has(c.url)) st.citations.set(c.url, c);
    },
  };
  try {
    for (;;) {
      const final = rounds >= spec.maxRounds;
      // Text before a tool round is narration; the report is the last round's text.
      text = "";
      const res = await conv.step(specs, hooks, { signal: st.signal, final });
      const u = st.usage.get(spec.provider.model) ?? { input_tokens: 0, output_tokens: 0 };
      u.input_tokens += res.usage.input_tokens;
      u.output_tokens += res.usage.output_tokens;
      st.usage.set(spec.provider.model, u);
      if (res.stop === "pause") {
        if (final) break;
        rounds++;
        continue;
      }
      if (res.stop !== "tool_use" || res.toolCalls.length === 0) {
        stop = res.stop;
        if (res.stop === "refusal") st.emit({ type: "error", agent: spec.id, error: "the model declined this request" });
        if (res.stop === "max_tokens") st.emit({ type: "error", agent: spec.id, error: "output truncated at the token limit" });
        break;
      }
      if (final) {
        stop = "max_rounds";
        break;
      }
      rounds++;
      const results: ToolOutcome[] = await Promise.all(
        res.toolCalls.map(async (call) => {
          st.emit({ type: "tool_call", agent: spec.id, id: call.id, name: call.name, input: call.input, server: false });
          const t = byName.get(call.name);
          const run: ToolRun = t
            ? await t.run(call.input, ctx)
            : ((await spec.extra?.run(call.name, call.input)) ?? { content: JSON.stringify({ error: `unknown tool ${call.name}` }), summary: `unknown tool ${call.name}`, isError: true });
          st.emit({ type: "tool_result", agent: spec.id, id: call.id, name: call.name, ok: !run.isError, summary: run.summary });
          return { id: call.id, name: call.name, content: run.content, isError: run.isError };
        }),
      );
      conv.addToolResults(results);
    }
  } catch (err) {
    stop = st.signal.aborted ? "timeout" : "error";
    st.emit({ type: "error", agent: spec.id, error: st.signal.aborted ? "out of time" : providerError(err) });
  }
  st.emit({ type: "agent_done", agent: spec.id, stop, rounds, report: text.slice(0, 8000) });
  return { text, stop, rounds };
}

function providerError(err: unknown): string {
  if (err && typeof err === "object" && "status" in err && typeof (err as { status: unknown }).status === "number") {
    const status = (err as { status: number }).status;
    if (status === 401 || status === 403) return "model provider rejected the credentials";
    if (status === 429) return "model provider is rate limiting";
    return `model provider error (HTTP ${status})`;
  }
  return `model provider error: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`;
}

const toolsNamed = (names: string[]) => ALL_READ_TOOLS.filter((t) => names.includes(t.spec.name));

const ConsultInput = z
  .object({
    tasks: z
      .array(z.object({ specialist: z.enum(SPECIALISTS.map((s) => s.id) as [string, ...string[]]), task: z.string().trim().min(10).max(2000) }).strict())
      .min(1)
      .max(5),
  })
  .strict();

const SpawnInput = z
  .object({
    name: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{1,30}$/),
    mandate: z.string().trim().min(10).max(1000),
    task: z.string().trim().min(10).max(2000),
    tools: z.array(z.string()).max(8),
    web_search: z.boolean().optional(),
  })
  .strict();

function orchestrationSpecs(): ToolSpec[] {
  return [
    {
      name: "consult_specialists",
      description:
        "Run one or more roster specialists in parallel on specific tasks and get their reports back. Put every specialist you need now in ONE call (max 5). Each investigates with its own tools and returns a short report: read, evidence, what would change it.",
      input_schema: {
        type: "object",
        properties: {
          tasks: {
            type: "array",
            minItems: 1,
            maxItems: 5,
            items: {
              type: "object",
              properties: {
                specialist: { type: "string", enum: SPECIALISTS.map((s) => s.id) },
                task: { type: "string", description: "specific question: coins, windows, what to decide" },
              },
              required: ["specialist", "task"],
              additionalProperties: false,
            },
          },
        },
        required: ["tasks"],
        additionalProperties: false,
      },
    },
    {
      name: "spawn_agent",
      description: `Start an ad-hoc analyst for an angle the roster lacks, with a mandate and only the read tools it needs (from: ${READ_TOOL_NAMES.join(", ")}), plus web search if needed. Returns its report. Max ${MAX_SPAWNS_PER_RUN} per run.`,
      input_schema: {
        type: "object",
        properties: {
          name: { type: "string", description: "short slug, e.g. eth-etf-flows" },
          mandate: { type: "string", description: "what this agent is for and how to judge" },
          task: { type: "string" },
          tools: { type: "array", items: { type: "string", enum: READ_TOOL_NAMES }, maxItems: 8 },
          web_search: { type: "boolean" },
        },
        required: ["name", "mandate", "task", "tools"],
        additionalProperties: false,
      },
    },
  ];
}

async function runChild(st: RunState, parent: string, id: string, role: string, system: string, tools: DeskTool[], webSearch: boolean, task: string): Promise<{ id: string; report: string; stop: string }> {
  if (st.agents >= MAX_AGENTS_PER_RUN) return { id, report: "", stop: `agent budget spent (${MAX_AGENTS_PER_RUN} per run)` };
  const provider = st.makeProvider("specialist");
  if (!provider) return { id, report: "", stop: "no model configured" };
  st.agents++;
  // web_search (Exa, or Anthropic's own native tool) is on every scout's
  // tool list when available; agents that should not browse are told so
  // instead, rather than left to skip the tool on their own.
  const sys = webSearch || !hasWebSearch(provider) ? system : `${system}\n\nDo not use web search for this task; work from your data tools.`;
  const res = await runAgent(
    { id, role, parent, system: sys, tools, maxRounds: SPECIALIST_MAX_ROUNDS, provider },
    `[current time ${st.service.now().toISOString()}]\n${task}`,
    st,
  );
  return { id, report: res.text.trim() || "(no report)", stop: res.stop };
}

function pmExtra(st: RunState) {
  return {
    specs: orchestrationSpecs(),
    async run(name: string, input: unknown): Promise<ToolRun> {
      if (name === "consult_specialists") {
        const parsed = ConsultInput.safeParse(input);
        if (!parsed.success) return { content: JSON.stringify({ error: "invalid input", issues: parsed.error.issues.map((i) => i.message) }), summary: "invalid input", isError: true };
        const reports = await Promise.all(
          parsed.data.tasks.map((t, i) => {
            const def = SPECIALISTS.find((s) => s.id === t.specialist)!;
            const id = parsed.data.tasks.filter((x) => x.specialist === t.specialist).length > 1 ? `${def.id}-${i + 1}` : def.id;
            return runChild(st, "pm", id, def.role, specialistSystem(def), toolsNamed(def.tools), def.webSearch, t.task);
          }),
        );
        return { content: JSON.stringify({ reports }).slice(0, 40_000), summary: reports.map((r) => `${r.id}: ${r.stop}`).join(", "), isError: false };
      }
      if (name === "spawn_agent") {
        const parsed = SpawnInput.safeParse(input);
        if (!parsed.success) return { content: JSON.stringify({ error: "invalid input", issues: parsed.error.issues.map((i) => i.message) }), summary: "invalid input", isError: true };
        if (st.spawns >= MAX_SPAWNS_PER_RUN) return { content: JSON.stringify({ error: `spawn budget spent (${MAX_SPAWNS_PER_RUN})` }), summary: "spawn budget spent", isError: true };
        const unknown = parsed.data.tools.filter((t) => !READ_TOOL_NAMES.includes(t));
        if (unknown.length) return { content: JSON.stringify({ error: `not read tools: ${unknown.join(", ")}` }), summary: "bad tools", isError: true };
        st.spawns++;
        const r = await runChild(st, "pm", `spawn:${parsed.data.name}`, parsed.data.mandate.slice(0, 80), spawnedSystem(parsed.data.name, parsed.data.mandate), toolsNamed(parsed.data.tools), parsed.data.web_search ?? false, parsed.data.task);
        return { content: JSON.stringify(r).slice(0, 20_000), summary: `${r.id}: ${r.stop}`, isError: false };
      }
      return { content: JSON.stringify({ error: `unknown tool ${name}` }), summary: `unknown tool ${name}`, isError: true };
    },
  };
}

export interface DeskRunOptions {
  service: DeskService;
  kind: "ask" | "cycle";
  /** The operator's question (ask) or the trigger description (cycle). */
  input: string;
  /** Prior turns of the operator's session (ask only, text only). */
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  /** Whether the PM may propose/exit/alert. Cycles act; asks act only when the operator enables it. */
  act: boolean;
  makeProvider?: ProviderFactory;
  timeoutMs?: number;
  signal?: AbortSignal;
  trigger?: unknown;
}

export const DEFAULT_RUN_TIMEOUT_MS = 240_000;

/**
 * A full desk run: records the run, drives the PM (which drives the team),
 * persists events, and always finishes with a `done` event.
 */
export async function runDesk(o: DeskRunOptions, emit: (e: DeskEvent) => void): Promise<{ runId: string; answer: string; stop: string }> {
  const { service } = o;
  const makeProvider = o.makeProvider ?? deskProviderFactory();
  const pmProvider = makeProvider("pm");
  if (!pmProvider) throw new Error("no model configured for the desk");

  const runId = await service.store.createRun(o.kind, o.input, o.trigger ?? null);
  const persisted: Array<{ seq: number; agent: string; type: string; data: unknown }> = [];
  let seq = 0;
  const record = (e: DeskEvent) => {
    emit(e);
    // Deltas stream live only; the agent's full report lands with agent_done.
    if (e.type === "text" || e.type === "reasoning") return;
    const { type, ...data } = e;
    persisted.push({ seq: seq++, agent: "agent" in e ? e.agent : "desk", type, data });
  };
  const flush = async () => {
    const batch = persisted.splice(0);
    if (batch.length) await service.store.appendEvents(runId, batch).catch((err) => console.error("[desk] event write failed", err));
  };
  const flusher = setInterval(() => void flush(), 2000);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), o.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS);
  const onOuter = () => ctrl.abort();
  o.signal?.addEventListener("abort", onOuter);

  const st: RunState = {
    service,
    runId,
    emit: record,
    makeProvider,
    signal: ctrl.signal,
    budget: { proposals: 0, alerts: 0 },
    agents: 1,
    spawns: 0,
    usage: new Map(),
    citations: new Map(),
  };
  record({ type: "run_start", runId, kind: o.kind, question: o.input });

  const roster = SPECIALISTS.map((s) => `- ${s.id}: ${s.role}: ${s.brief}${s.webSearch ? " (web)" : ""}`).join("\n");
  const now = service.now().toISOString();
  const history = (o.history ?? []).map((t) => `${t.role === "user" ? "Operator" : "PM"}: ${t.content}`).join("\n\n");
  const task =
    o.kind === "cycle"
      ? cycleTask(o.input, now)
      : `[current time ${now}]${history ? `\nEarlier in this session:\n${history}\n` : ""}\nOperator: ${o.input}`;

  let answer = "";
  let stop = "error";
  let error: string | null = null;
  try {
    const res = await runAgent(
      {
        id: "pm",
        role: "Portfolio manager",
        parent: null,
        system: pmSystem(roster, o.act),
        tools: o.act ? [...ALL_READ_TOOLS, ...ACTION_TOOLS] : ALL_READ_TOOLS,
        extra: pmExtra(st),
        maxRounds: PM_MAX_ROUNDS,
        provider: pmProvider,
      },
      task,
      st,
    );
    answer = res.text.trim();
    stop = res.stop;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  } finally {
    clearTimeout(timer);
    clearInterval(flusher);
    o.signal?.removeEventListener("abort", onOuter);
  }
  const total = [...st.usage.values()].reduce((a, u) => ({ input_tokens: a.input_tokens + u.input_tokens, output_tokens: a.output_tokens + u.output_tokens }), { input_tokens: 0, output_tokens: 0 });
  const costUsd = estimateCost(st.usage);
  if (st.citations.size) record({ type: "citations", citations: [...st.citations.values()].map((c) => ({ url: c.url, title: c.title })) });
  record({ type: "done", runId, stop, usage: total, costUsd });
  await flush();
  await service.store.finishRun(runId, {
    status: error || stop === "error" ? "error" : "done",
    answer: answer || null,
    usage: Object.fromEntries(st.usage),
    costUsd,
    error,
  });
  return { runId, answer, stop };
}
