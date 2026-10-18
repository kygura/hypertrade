// The agent loop. Mirrors src/server/routes/analyst.ts runAnalyst: up to
// maxRounds tool rounds, then one final round with tools disabled; provider
// pause stops continue the turn; abort and timeout end it with the partial
// text kept. Events are callbacks (the UI renders them); history is text-only
// turns, kept for the session.
import { resolveProvider, type AnalystEnv, type LLMProvider, type ToolOutcome, type Turn } from "../../../src/server/llm/provider.js";
import { buildAgentPrompt } from "./prompt.js";
import { agentTools, type AgentDeps, type AgentTool } from "./tools.js";

export interface AgentEvents {
  onText(delta: string): void;
  onReasoning?(delta: string): void;
  /** inputSummary is a short one-liner for the tool line ("BTC", "coin=BTC interval=1h"). */
  onToolStart(name: string, inputSummary: string): void;
  onToolEnd(name: string, ok: boolean, summary: string): void;
  /** Provider-hosted tools (web search): a call started or finished. */
  onServerTool?(name: string, summary: string): void;
}

export interface AgentOptions {
  provider: LLMProvider;
  deps: AgentDeps;
  maxRounds?: number;
  timeoutMs?: number;
  now?: () => Date;
}

/** end | tool_use-less provider stops (max_tokens, refusal) | max_rounds | aborted | timeout */
export interface AskResult {
  text: string;
  stop: string;
}

export const MAX_TOOL_ROUNDS = 8;
export const TIMEOUT_MS = 120_000;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** "BTC" for one-field input, else "k=v k=v"; never more than ~80 chars. */
export function summarizeInput(input: unknown): string {
  if (input == null || typeof input !== "object") return input == null ? "" : clip(String(input), 80);
  const v = (x: unknown) => (typeof x === "object" && x !== null ? JSON.stringify(x) : String(x));
  const entries = Object.entries(input as Record<string, unknown>).filter(([, x]) => x !== undefined);
  if (entries.length === 1) return clip(v(entries[0]![1]), 80);
  return clip(entries.map(([k, x]) => `${k}=${v(x)}`).join(" "), 80);
}

/** Provider failures without request details (keys never appear here). */
function providerError(err: unknown): string {
  if (err && typeof err === "object" && "status" in err && typeof (err as { status: unknown }).status === "number") {
    const status = (err as { status: number }).status;
    if (status === 401 || status === 403) return "agent provider rejected the credentials";
    if (status === 429) return "agent provider is rate limiting; try again shortly";
    return `agent provider error (HTTP ${status})`;
  }
  return `agent provider error: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`;
}

export class Agent {
  history: Turn[] = [];
  private readonly provider: LLMProvider;
  private readonly deps: AgentDeps;
  private readonly tools: AgentTool[];
  private readonly maxRounds: number;
  private readonly timeoutMs: number;
  private readonly now: () => Date;

  constructor(o: AgentOptions) {
    this.provider = o.provider;
    this.deps = o.deps;
    this.tools = agentTools(o.deps);
    this.maxRounds = o.maxRounds ?? MAX_TOOL_ROUNDS;
    this.timeoutMs = o.timeoutMs ?? TIMEOUT_MS;
    this.now = o.now ?? (() => new Date());
  }

  clear(): void {
    this.history = [];
  }

  async ask(question: string, ev: AgentEvents, signal?: AbortSignal): Promise<AskResult> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const now = this.now();
    const system = buildAgentPrompt({ config: this.deps.getState().config, now, webSearch: this.provider.webSearch });
    const conv = this.provider.start(system, this.history, `[current time ${now.toISOString()}]\n${question}`);
    const specs = this.tools.map((t) => t.spec);
    const parts: string[] = [];
    let current = "";
    let stop = "end";
    let rounds = 0;

    const hooks = {
      onText: (delta: string) => {
        current += delta;
        ev.onText(delta);
      },
      onReasoning: (delta: string) => ev.onReasoning?.(delta),
      onServerToolCall: (c: { name: string; input: unknown }) => ev.onServerTool?.(c.name, summarizeInput(c.input)),
      onServerToolResult: (_id: string, name: string, ok: boolean, summary: string) => ev.onServerTool?.(name, `${ok ? "" : "failed: "}${summary}`),
    };
    const endRound = () => {
      if (current.trim()) parts.push(current.trim());
      current = "";
    };

    try {
      for (;;) {
        const final = rounds >= this.maxRounds;
        const res = await conv.step(specs, hooks, { signal: sig, final });
        endRound();
        if (res.stop === "pause") {
          // Provider-hosted tool paused a long turn; continue it.
          if (final) break;
          rounds++;
          continue;
        }
        if (res.stop !== "tool_use" || res.toolCalls.length === 0) {
          stop = res.stop;
          break;
        }
        if (final) {
          stop = "max_rounds";
          break;
        }
        rounds++;
        const results: ToolOutcome[] = [];
        for (const call of res.toolCalls) {
          if (sig.aborted) throw new DOMException("aborted", "AbortError");
          ev.onToolStart(call.name, summarizeInput(call.input));
          const r = await this.runTool(call.name, call.input, sig);
          ev.onToolEnd(call.name, !r.isError, r.summary);
          results.push({ id: call.id, name: call.name, content: r.content, isError: r.isError });
        }
        conv.addToolResults(results);
      }
    } catch (err) {
      endRound();
      if (sig.aborted) stop = signal?.aborted ? "aborted" : "timeout";
      else throw new Error(providerError(err));
    }

    const text = parts.join("\n\n");
    this.history.push({ role: "user", content: question }, { role: "assistant", content: text || `[${stop === "end" ? "no answer" : stop}]` });
    return { text, stop };
  }

  private async runTool(name: string, input: unknown, signal: AbortSignal): Promise<{ content: string; isError: boolean; summary: string }> {
    const tool = this.tools.find((t) => t.spec.name === name);
    if (!tool) return { content: `unknown tool ${name}`, isError: true, summary: `unknown tool ${name}` };
    try {
      const content = await tool.run(input, signal);
      return { content, isError: false, summary: `${content.length} chars` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: msg, isError: true, summary: clip(msg, 120) };
    }
  }
}

export function createAgent(env: AnalystEnv, deps: AgentDeps): { agent: Agent | null; label: string; reason?: string } {
  const provider = resolveProvider(env);
  if (!provider) return { agent: null, label: "agent off", reason: "no LLM configured: set ANTHROPIC_API_KEY or ANALYST_PROVIDER" };
  return { agent: new Agent({ provider, deps }), label: provider.model };
}
