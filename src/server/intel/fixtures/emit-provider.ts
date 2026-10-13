import type { Conversation, LLMProvider, StepOptions, StepResult } from "../../llm/provider.js";
import type { LlmDeps } from "../llm.js";
import { MemoryIntelStore } from "../store.js";

// Test support: a provider that answers every step by calling `emit` with
// whatever `reply` returns for the prompt. Records prompts and step options.

export class EmitProvider implements LLMProvider {
  readonly id = "anthropic" as const;
  readonly webSearch = true;
  readonly model = "scripted";
  prompts: string[] = [];
  opts: StepOptions[] = [];
  constructor(private readonly reply: (prompt: string) => unknown) {}
  start(_system: string, _history: unknown[], question: string): Conversation {
    this.prompts.push(question);
    const self = this;
    return {
      async step(_tools, _hooks, opts): Promise<StepResult> {
        self.opts.push(opts);
        return { stop: "tool_use", toolCalls: [{ id: "t1", name: "emit", input: self.reply(question) }], usage: { input_tokens: 1, output_tokens: 1 } };
      },
      addToolResults() {},
    };
  }
}

export function llmDeps(provider: LLMProvider | null, store = new MemoryIntelStore(), now = () => new Date("2026-10-13T12:00:00Z")): LlmDeps {
  return { makeProvider: () => provider, cache: store, now, dailyCap: 200 };
}
