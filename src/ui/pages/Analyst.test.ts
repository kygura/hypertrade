import { describe, expect, test } from "bun:test";
import type { BranchConfig } from "../../shared/types";
import { compactSim, downsample, type AnalystCatalog, type SimResultEvent } from "../lib/analyst";
import { applyEvent, resolveChoice, toHistory, type TurnState } from "./Analyst";

const turn = (): TurnState => ({
  id: 1,
  question: "q",
  asked: null,
  answer: "",
  reasoning: "",
  trace: [],
  sims: [],
  saved: {},
  citations: [],
  error: null,
  done: null,
  streaming: true,
  startedAt: 0,
  finishedAt: null,
});

describe("applyEvent", () => {
  test("accumulates reasoning and text separately, then closes on done", () => {
    let t = turn();
    t = applyEvent(t, { type: "reasoning", delta: "think " });
    t = applyEvent(t, { type: "reasoning", delta: "more" });
    t = applyEvent(t, { type: "text", delta: "Answer" });
    t = applyEvent(t, { type: "done", usage: { input_tokens: 1, output_tokens: 2 }, model: "kimi-k3", provider: "moonshot", label: "Moonshot Kimi", rounds: 0, stop: "end", effort: "high" }, 500);
    expect(t.reasoning).toBe("think more");
    expect(t.answer).toBe("Answer");
    expect(t.streaming).toBe(false);
    expect(t.finishedAt).toBe(500);
    expect(t.done?.label).toBe("Moonshot Kimi");
  });
});

const CATALOG: AnalystCatalog = {
  default: { provider: "anthropic", model: "claude-opus-5-5" },
  providers: [
    { id: "anthropic", label: "Anthropic", available: false, reason: "set ANALYST_ANTHROPIC_API_KEY", models: [{ id: "claude-opus-5-5", label: "Opus 5.5", note: "", tier: "frontier", effort: true }] },
    {
      id: "deepseek",
      label: "DeepSeek",
      available: true,
      models: [{ id: "deepseek-v4-pro", label: "V4 Pro", note: "", tier: "frontier", effort: true, efforts: ["low", "high", "max"], defaultEffort: "high" }],
    },
  ],
};

describe("resolveChoice", () => {
  test("falls through to the first available provider when the default is unconfigured", () => {
    expect(resolveChoice(CATALOG, null)).toEqual({ provider: "deepseek", model: "deepseek-v4-pro", effort: "high" });
  });
  test("a stored effort the model doesn't take becomes the model default", () => {
    expect(resolveChoice(CATALOG, { provider: "deepseek", model: "deepseek-v4-pro", effort: "medium" }).effort).toBe("high");
    expect(resolveChoice(CATALOG, { provider: "deepseek", model: "deepseek-v4-pro", effort: "max" }).effort).toBe("max");
  });
});

const cfg: BranchConfig = { startDate: "2026-01-01", initialCapitalUsd: 10000, allocations: [{ coin: "SOL", weightPct: 100, leverage: 3 }], rebalance: "none" };
const pts = (n: number) => Array.from({ length: n }, (_, i) => ({ ts: i, value: i }));
const sim: SimResultEvent = {
  type: "sim_result",
  id: "tc1",
  intent: { title: "t", assumptions: [], branches: [{ name: "SOL 3x", config: cfg }] },
  branches: [
    {
      name: "SOL 3x",
      config: cfg,
      warnings: [],
      result: {
        equity: pts(1000),
        benchmarks: { btc: pts(1000), usdc: pts(50) },
        stats: { finalValue: 1, cagrPct: 1, maxDrawdownPct: 1, vsBtcPct: 1, vsUsdcPct: 1 },
        montecarlo: { median: pts(500), p10: pts(500), p90: pts(500) },
      },
    },
  ],
};

describe("sim_result", () => {
  test("applyEvent appends sims in order", () => {
    let t = applyEvent(turn(), sim);
    t = applyEvent(t, { ...sim, id: "tc2" });
    expect(t.sims.map((s) => s.id)).toEqual(["tc1", "tc2"]);
  });
  test("toHistory adds the [paths] trailer in sim mode only", () => {
    const t = { ...applyEvent(turn(), sim), answer: "done", streaming: false };
    const sims = toHistory([t], "sim")[1]!.content;
    expect(sims).toContain("\n[paths]\n");
    expect(sims).toContain(JSON.stringify({ name: "SOL 3x", config: cfg }));
    expect(toHistory([t])[1]!.content).toBe("done");
  });
  test("downsample caps at 200 and keeps endpoints", () => {
    const d = downsample(pts(1000));
    expect(d.length).toBe(200);
    expect(d[0]).toEqual({ ts: 0, value: 0 });
    expect(d[199]).toEqual({ ts: 999, value: 999 });
    expect(downsample(pts(50)).length).toBe(50);
  });
  test("compactSim thins every stored series", () => {
    const r = compactSim(sim).branches[0]!.result!;
    expect([r.equity.length, r.benchmarks.btc.length, r.benchmarks.usdc.length, r.montecarlo!.p90.length]).toEqual([200, 200, 50, 200]);
  });
});
