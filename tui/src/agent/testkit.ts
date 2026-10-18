// Test helpers for the agent: a scripted LLMProvider and fixture-backed deps.
import type { Conversation, LLMProvider, StepHooks, StepOptions, StepResult, StopKind, ToolOutcome, ToolSpec, Turn } from "../../../src/server/llm/provider.js";
import { demoAccountAddress, DemoInfo } from "../core/demo.js";
import type { AppState, Config, Ticket, TicketAction } from "../core/types.js";
import type { AgentDeps } from "./tools.js";

export interface ScriptStep {
  text?: string;
  calls?: Array<{ name: string; input: unknown }>;
  stop?: StopKind;
  /** Never resolve until the step's signal aborts (then reject like a real provider). */
  hang?: boolean;
}

export class ScriptedLLM implements LLMProvider {
  readonly id = "anthropic" as const;
  readonly webSearch = false;
  systems: string[] = [];
  questions: string[] = [];
  histories: Turn[][] = [];
  finals: boolean[] = [];
  toolSets: ToolSpec[][] = [];
  results: ToolOutcome[][] = [];
  constructor(readonly script: ScriptStep[], readonly model = "scripted-1") {}

  start(system: string, history: Turn[], question: string): Conversation {
    this.systems.push(system);
    this.histories.push([...history]);
    this.questions.push(question);
    const steps = [...this.script];
    let n = 0;
    const self = this;
    return {
      async step(tools: ToolSpec[], hooks: StepHooks, opts: StepOptions): Promise<StepResult> {
        self.finals.push(!!opts.final);
        self.toolSets.push(tools);
        const s = steps.shift() ?? { text: "done" };
        if (s.hang) {
          await new Promise<never>((_, reject) => {
            if (opts.signal.aborted) reject(new Error("aborted"));
            opts.signal.addEventListener("abort", () => reject(new Error("aborted")));
          });
        }
        if (s.text) hooks.onText(s.text);
        const toolCalls = (s.calls ?? []).map((c) => ({ id: `call_${++n}`, name: c.name, input: c.input }));
        return { stop: s.stop ?? (toolCalls.length ? "tool_use" : "end"), toolCalls, usage: { input_tokens: 1, output_tokens: 1 } };
      },
      addToolResults(r: ToolOutcome[]) {
        self.results.push(r);
      },
    };
  }
}

export const NOW = Date.now();

export function testConfig(over: Partial<Config> = {}): Config {
  return {
    network: "testnet",
    account: demoAccountAddress,
    canTrade: true,
    maxNotionalUsd: 1000,
    slippage: 0.003,
    watch: [],
    limits: { maxRiskPct: 1, maxOpenRiskPct: 3, maxGrossLeverage: 5, maxCoinLeverage: 5, maxPositions: 4, minRewardRisk: 1.5 },
    defaultLeverage: 3,
    lab: null,
    demo: true,
    ...over,
  };
}

export function fakeTicket(action: TicketAction, over: Partial<Ticket> = {}): Ticket {
  const coin = action.kind === "open" ? action.intent.asset : action.kind === "close" || action.kind === "stop" ? action.coin : "BTC";
  return {
    id: "t-1234",
    action,
    network: "testnet",
    coin,
    side: action.kind === "open" ? action.intent.side : null,
    size: 0.0123,
    notionalUsd: 750.4,
    entryPx: 61000,
    stopPx: 59800,
    tpPx: null,
    liqPx: 41000,
    riskUsd: 14.8,
    riskPct: 0.5,
    rr: null,
    leverage: 3,
    slippageBps: 1.2,
    verdict: null,
    blockers: [],
    warnings: [],
    notes: [],
    canSend: true,
    markPx: 61000,
    quotedAt: NOW,
    ...over,
  };
}

export async function makeDeps(over: Partial<AgentDeps> = {}, config: Config = testConfig()): Promise<{ deps: AgentDeps; drafts: TicketAction[] }> {
  const info = new DemoInfo();
  const markets = await info.markets();
  const account = await info.account(demoAccountAddress, markets);
  const state: AppState = { config, markets, marketsAt: NOW, marketsError: null, account, accountError: null, alerts: [], ws: "off" };
  const drafts: TicketAction[] = [];
  const deps: AgentDeps = {
    getState: () => state,
    info,
    oiSeries: () => [],
    pulse: async () => {
      throw new Error("lab not configured: set LAB_URL and LAB_API_TOKEN");
    },
    brief: async () => null,
    draftOrder: async (a) => {
      drafts.push(a);
      return fakeTicket(a);
    },
    ...over,
  };
  return { deps, drafts };
}
