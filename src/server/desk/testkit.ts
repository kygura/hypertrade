import type { FundingPoint } from "../../shared/hl-client.js";
import type { AssetCtx, Candle } from "../../shared/types.js";
import type { Conversation, LLMProvider, StepHooks, StepResult, ToolOutcome, ToolSpec } from "../llm/provider.js";
import { loadDeskConfig, type DeskConfig } from "./config.js";
import type { MarketData } from "./data.js";
import type { Notifier, Alert } from "./notify.js";
import { DeskService } from "./service.js";
import { MemoryStore } from "./store.js";

// Test doubles for the desk: fixed market data, a recording notifier and a
// scripted LLM provider. Imported by *.test.ts only.

const HOUR = 3_600_000;

export function ctx(name: string, markPx: number, over: Partial<AssetCtx> = {}): AssetCtx {
  return {
    name,
    szDecimals: name === "BTC" ? 5 : 2,
    markPx,
    oraclePx: markPx,
    midPx: markPx,
    dayNtlVlm: 1e8,
    prevDayPx: markPx,
    openInterest: 1e9 / markPx,
    funding: 0.00001,
    premium: 0,
    dayChange: 0,
    isDelisted: false,
    maxLeverage: 20,
    ...over,
  };
}

/** Hourly candles from `prices` (one close per hour), ending at `end`. */
export function hourly(prices: number[], end: number, vol: (i: number) => number = () => 100): Candle[] {
  return prices.map((c, i) => {
    const o = i === 0 ? c : prices[i - 1]!;
    const t = end - (prices.length - i) * HOUR;
    return { t, T: t + HOUR - 1, o, h: Math.max(o, c) * 1.001, l: Math.min(o, c) * 0.999, c, v: vol(i) };
  });
}

export class FakeData implements MarketData {
  ctxList: AssetCtx[];
  candleMap = new Map<string, Candle[]>();
  fundingMap = new Map<string, FundingPoint[]>();
  seriesMap = new Map<string, Array<{ t: number; v: number }>>();
  constructor(ctxs: AssetCtx[]) {
    this.ctxList = ctxs;
  }
  setMark(coin: string, px: number) {
    this.ctxList = this.ctxList.map((c) => (c.name === coin ? { ...c, markPx: px } : c));
  }
  async ctxs() {
    return this.ctxList;
  }
  async candles(coin: string, _i: string, start: number, end: number) {
    return (this.candleMap.get(coin) ?? []).filter((c) => c.t >= start && c.t <= end);
  }
  async funding(coin: string, start: number, end: number) {
    return (this.fundingMap.get(coin) ?? []).filter((f) => f.t >= start && f.t <= end);
  }
  async series(id: string, from: Date) {
    return (this.seriesMap.get(id) ?? []).filter((p) => p.t >= from.getTime());
  }
  async summary() {
    return [];
  }
  async watchedAccount() {
    return { venue: "hyperliquid (watch)", equityUsd: 0, dayPnlUsd: 0, positions: [], available: false, note: "test" };
  }
  async cycles() {
    return { regime: "test" };
  }
}

export class RecordingNotifier implements Notifier {
  sent: Alert[] = [];
  readonly channels = ["test"];
  async send(a: Alert) {
    this.sent.push(a);
    return ["test"];
  }
}

export function makeService(opts: { ctxs?: AssetCtx[]; env?: Record<string, string>; now?: () => Date; config?: Partial<DeskConfig> } = {}) {
  const now = opts.now ?? (() => new Date("2026-10-05T12:00:00Z"));
  const store = new MemoryStore(now);
  const data = new FakeData(opts.ctxs ?? [ctx("BTC", 100_000), ctx("ETH", 4_000), ctx("SOL", 200)]);
  const notifier = new RecordingNotifier();
  const config = { ...loadDeskConfig(opts.env ?? {}), ...opts.config };
  const service = new DeskService({ config, store, data, notifier, now });
  return { service, store, data, notifier, config };
}

/** A scripted model turn: optional text, then tool calls (or none to finish). */
export interface ScriptStep {
  text?: string;
  calls?: Array<{ name: string; input: unknown }>;
}

/**
 * Provider whose conversations follow a script chosen by the system prompt
 * (so the PM and each specialist get their own lines). Records tool results.
 */
export class ScriptedProvider implements LLMProvider {
  readonly id = "anthropic" as const;
  readonly webSearch = false;
  results: ToolOutcome[][] = [];
  systems: string[] = [];
  constructor(
    readonly model: string,
    private readonly pick: (system: string, task: string) => ScriptStep[],
  ) {}
  start(system: string, _history: unknown[], question: string): Conversation {
    this.systems.push(system);
    const script = [...this.pick(system, question)];
    let n = 0;
    const self = this;
    return {
      async step(_tools: ToolSpec[], hooks: StepHooks, opts): Promise<StepResult> {
        const s = (opts.final ? { text: script[script.length - 1]?.text ?? "final" } : script.shift()) ?? { text: "done" };
        if (s.text) hooks.onText(s.text);
        const calls = (s.calls ?? []).map((c) => ({ id: `call_${++n}`, name: c.name, input: c.input }));
        return { stop: calls.length ? "tool_use" : "end", toolCalls: calls, usage: { input_tokens: 1000, output_tokens: 100 } };
      },
      addToolResults(r: ToolOutcome[]) {
        self.results.push(r);
      },
    };
  }
}
