import { describe, expect, test } from "bun:test";
import type { Citation, Conversation, LLMProvider, StepOptions, StepResult } from "../llm/provider.js";
import type { FlowFlag } from "../../shared/intel.js";
import { llmDeps } from "./fixtures/emit-provider.js";
import { MemoryIntelStore } from "./store.js";
import { NO_CAUSE, RESEARCH_DEADLINE_MS, RESEARCH_NO_WEB_SEARCH, runResearch, type ResearchDeps } from "./research.js";

// Fixture tests, no network: a scripted provider that fires the same hooks the
// Anthropic provider does (server tool call, search results, citations).

const T0 = new Date("2026-10-14T12:00:00Z");
const URL_A = "https://news.example.com/jito-exploit";
const RESULTS = [{ url: URL_A, title: "Jito exploit drains $12M from restaking pool" }];
const CITES: Citation[] = [{ url: URL_A, title: null, cited_text: "Attackers drained $12M on Tuesday" }];

interface Script {
  emit: unknown;
  results?: { url: string; title: string | null }[];
  cites?: Citation[];
  searches?: number;
}

class SearchProvider implements LLMProvider {
  readonly id = "anthropic" as const;
  readonly model = "claude-opus-5-5";
  prompts: string[] = [];
  opts: StepOptions[] = [];
  constructor(
    private readonly script: Script,
    readonly webSearch = true,
  ) {}
  start(_system: string, _history: unknown[], question: string): Conversation {
    this.prompts.push(question);
    const s = this.script;
    const self = this;
    return {
      async step(_tools, hooks, opts): Promise<StepResult> {
        self.opts.push(opts);
        for (let i = 0; i < (s.searches ?? 1); i++) hooks.onServerToolCall?.({ id: `s${i}`, name: "web_search", input: {} });
        hooks.onSearchResults?.(s.results ?? RESULTS);
        for (const c of s.cites ?? CITES) hooks.onCitation?.(c);
        return { stop: "tool_use", toolCalls: [{ id: "t1", name: "emit", input: s.emit }], usage: { input_tokens: 1000, output_tokens: 500 } };
      },
      addToolResults() {},
    };
  }
}

const flag: FlowFlag = { id: "detector:crowded_long:SOL:24h:x", asset: "SOL", kind: "detector", name: "crowded_long", window: "24h", numbers: { oi_z: 2.4 }, score: 2.4, degraded: false, ts: "2026-10-14T11:00:00.000Z", researchId: null };

async function setup(script: Script, opts: { webSearch?: boolean; dailyUsd?: number; clock?: () => Date } = {}) {
  const clock = opts.clock ?? (() => T0);
  const store = new MemoryIntelStore(clock);
  await store.insertSnapshots([
    { asset: "SOL", ts: "2026-10-14T11:30:00.000Z", price: 150.5, vol24h: null, funding: 0.0001, oiUsd: 2.5e9, premium: null, basis: null, depthBid1: null, depthAsk1: null, depthBid2: null, depthAsk2: null, spreadBps: null },
  ]);
  const provider = new SearchProvider(script, opts.webSearch ?? true);
  const llm = { ...llmDeps(provider, store, clock), dailyUsd: opts.dailyUsd };
  const deps: ResearchDeps = { store, llm, exposure: async () => [{ asset: "SOL", side: "long", notionalUsd: 1500 }], now: clock };
  return { store, provider, deps };
}

const input = { question: "Why did SOL drop today?", asset: "SOL", trigger: "manual" as const, flag };
const emit = (over: Record<string, unknown>) => ({ explanation: "", evidence: [], confidence: "medium", openQuestions: [], ...over });

describe("runResearch", () => {
  test("found: observed claim backed by a provider result survives, search budget is passed per call", async () => {
    const { deps, provider, store } = await setup({
      searches: 3,
      emit: emit({
        explanation: "An exploit drained $12M from a restaking pool. SOL is at 150.5.",
        evidence: [{ claim: "Attackers drained $12M", url: URL_A, ts: "2026-10-14T08:00:00Z", type: "observed" }],
        confidence: "high",
        openQuestions: ["Did the team confirm the loss?"],
      }),
    });
    const r = (await runResearch(deps, input))!;
    expect(r).toMatchObject({ status: "found", trigger: "manual", flagId: flag.id, asset: "SOL", confidence: "high", searches: 3, model: "claude-opus-5-5" });
    expect(r.evidence).toEqual([{ claim: "Attackers drained $12M", url: URL_A, ts: "2026-10-14T08:00:00.000Z", type: "observed" }]);
    expect(r.costUsd).toBeCloseTo((1000 * 4 + 500 * 20) / 1e6, 8);
    expect(provider.opts[0]).toMatchObject({ webSearch: true, maxUses: 8 });
    expect(provider.prompts[0]).toContain("<untrusted>");
    expect((await store.researchForFlag(flag.id))?.id).toBe(r.id);
  });

  test("no_cause: empty evidence gives the fixed sentence plus what was checked", async () => {
    const { deps } = await setup({ emit: emit({ explanation: "Maybe something happened." }), searches: 2 });
    const r = (await runResearch(deps, input))!;
    expect(r.status).toBe("no_cause");
    expect(r.explanation.startsWith(`${NO_CAUSE} Checked 2 web searches`)).toBe(true);
    expect(r.evidence).toEqual([]);
  });

  test("capped: over the dollar cap, no LLM call", async () => {
    const { deps, provider } = await setup({ emit: emit({}) }, { dailyUsd: 0 });
    const r = (await runResearch(deps, input))!;
    expect(r.status).toBe("capped");
    expect(provider.prompts).toHaveLength(0);
  });

  test("a provider without web search fails without calling or locking", async () => {
    const { deps, provider, store } = await setup({ emit: emit({}) }, { webSearch: false });
    const r = (await runResearch(deps, input))!;
    expect(r).toMatchObject({ status: "failed", explanation: RESEARCH_NO_WEB_SEARCH });
    expect(provider.prompts).toHaveLength(0);
    expect(store.research.some((x) => x.status === "running")).toBe(false);
  });

  test("an invented URL is downgraded to hypothesis and its url is not kept", async () => {
    const { deps } = await setup({
      emit: emit({ explanation: "A pool was drained.", evidence: [{ claim: "A pool was drained", url: "https://invented.example.org/x", ts: null, type: "observed" }] }),
    });
    const r = (await runResearch(deps, input))!;
    expect(r.status).toBe("found");
    expect(r.evidence).toEqual([{ claim: "A pool was drained", url: null, ts: null, type: "hypothesis" }]);
    expect(r.confidence).toBe("low"); // no observed claim backs it
  });

  test("a number missing from its result's excerpt downgrades the claim (url kept); a number found nowhere drops it", async () => {
    const { deps } = await setup({
      emit: emit({
        explanation: "A pool was drained.",
        evidence: [
          { claim: "SOL traded at 150.5 when it hit", url: URL_A, ts: null, type: "observed" }, // 150.5 is in our payload, not in the excerpt
          { claim: "The pool lost $99M", url: URL_A, ts: null, type: "observed" }, // in neither
        ],
      }),
    });
    const r = (await runResearch(deps, input))!;
    expect(r.evidence).toEqual([{ claim: "SOL traded at 150.5 when it hit", url: URL_A, ts: null, type: "hypothesis" }]);
  });

  test("with no result URLs exposed every claim is a hypothesis", async () => {
    const { deps } = await setup({
      results: [],
      emit: emit({ explanation: "A pool was drained.", evidence: [{ claim: "Attackers drained funds", url: URL_A, ts: null, type: "observed" }] }),
    });
    const r = (await runResearch(deps, input))!;
    expect(r.evidence.map((e) => e.type)).toEqual(["hypothesis"]);
  });

  test("an explanation number that is in neither the payload nor a surviving observed claim is dropped", async () => {
    const { deps } = await setup({
      emit: emit({
        explanation: "An exploit drained $12M. SOL fell 77% on it. SOL is at 150.5.",
        evidence: [{ claim: "Attackers drained $12M", url: URL_A, ts: null, type: "observed" }],
      }),
    });
    const r = (await runResearch(deps, input))!;
    expect(r.explanation).toBe("An exploit drained $12M. SOL is at 150.5.");
  });

  test("advice lines are dropped from claims, explanation and open questions", async () => {
    const { deps } = await setup({
      emit: emit({
        explanation: "An exploit hit the pool. Sell the rip.",
        evidence: [
          { claim: "Buy SOL now", url: null, ts: null, type: "hypothesis" },
          { claim: "A pool was exploited", url: null, ts: null, type: "hypothesis" },
        ],
        openQuestions: ["You should sell SOL?", "Was the loss confirmed?"],
      }),
    });
    const r = (await runResearch(deps, input))!;
    expect(r.explanation).toBe("An exploit hit the pool.");
    expect(r.evidence.map((e) => e.claim)).toEqual(["A pool was exploited"]);
    expect(r.openQuestions).toEqual(["Was the loss confirmed?"]);
  });

  test("the running lock blocks a second run, then goes stale after deadline + 15s", async () => {
    let now = T0;
    const clock = () => now;
    const { deps, store } = await setup({ emit: emit({}) }, { clock });
    const held = await store.acquireResearch({ trigger: "manual", asset: "SOL", question: "q", status: "running", explanation: "", evidence: [], confidence: "low", openQuestions: [], searches: 0, costUsd: 0, model: "" }, new Date(0));
    expect(held?.status).toBe("running");

    now = new Date(T0.getTime() + RESEARCH_DEADLINE_MS + 14_000);
    expect(await runResearch(deps, input)).toBeNull();

    now = new Date(T0.getTime() + RESEARCH_DEADLINE_MS + 16_000);
    const r = await runResearch(deps, input);
    expect(r?.status).toBe("no_cause");
    expect(store.research.find((x) => x.id === held!.id)?.status).toBe("failed");
    expect(store.research.filter((x) => x.status === "running")).toHaveLength(0); // lock released
  });
});
