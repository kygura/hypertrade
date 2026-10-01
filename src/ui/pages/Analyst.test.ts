import { describe, expect, test } from "bun:test";
import type { AnalystCatalog } from "../lib/analyst";
import { applyEvent, resolveChoice, type TurnState } from "./Analyst";

const turn = (): TurnState => ({
  id: 1,
  question: "q",
  asked: null,
  answer: "",
  reasoning: "",
  trace: [],
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
