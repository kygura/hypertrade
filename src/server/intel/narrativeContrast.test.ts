import { describe, expect, test } from "bun:test";
import type { NarrativeFlow, NarrativeView } from "../../shared/intel.js";
import type { Citation, Conversation, LLMProvider, StepResult } from "../llm/provider.js";
import { llmDeps } from "./fixtures/emit-provider.js";
import { agreement, flowPayload, runContrast, vetContrast } from "./narrativeContrast.js";
import type { Seen } from "./research.js";
import { MemoryIntelStore } from "./store.js";

const NOW = new Date("2026-10-27T12:00:00Z");
const URL_A = "https://news.example.com/zec-halving";
const CITED = "Zcash's halving cut issuance by 50% in November, and exchange balances fell to 1.2M ZEC";

const FLOW: NarrativeFlow = {
  id: "privacy",
  label: "Privacy",
  tokens: ["ZEC", "XMR"],
  covered: ["ZEC", "XMR"],
  missing: [],
  oiUsd: 774_000_000,
  firstSeen: "2026-10-08",
  htf: { pricePct7d: 12.4512, pricePct30d: 30.1, relBtc7d: 11.9, relBtc30d: 25.3, oiPct7d: 18.2, oiPct30d: 40.7, funding: 2.4e-5, fundingZ: 2.6 },
  stage: "crowded",
  ltf: [
    { window: "1h", pricePct: 0.4, priceZ: 0.8, oiPct: 0.2, oiZ: 0.5, quadrant: "quiet" },
    { window: "6h", pricePct: 3.1, priceZ: 2.2, oiPct: 6.4, oiZ: 2.9, quadrant: "long_build" },
    { window: "24h", pricePct: 4.25, priceZ: 1.4, oiPct: 9, oiZ: 1.8, quadrant: "long_build" },
  ],
  alignment: "with",
  flowScore: 2.9,
};
const VIEW: NarrativeView = { lean: "fade", note: "Feels crowded after a 30% month, funding hot", updatedAt: NOW.toISOString() };

const caseOf = (claim: string, type: "observed" | "hypothesis", url: string | null = URL_A) => ({ case: claim, evidence: [{ claim, url, ts: null, type }] });
const OUT = {
  summary: "Privacy is up 12.45% over 7d with funding z 2.6. The evidence leans toward continuation.",
  favours: "continuation" as const,
  confidence: "medium" as const,
  continuation: caseOf("Zcash's halving cut issuance by 50%", "observed"),
  fade: caseOf("Funding is stretched, so late longs may unwind", "hypothesis", null),
  viewWhy: "The trader sees a crowded trade; funding z 2.6 agrees, but supply is shrinking.",
  confirms: ["OI keeps rising while funding cools"],
  invalidates: ["Exchange balances rise back above 1.5M ZEC", "Sell the next pop."],
  openQuestions: [],
};

const seen = (): Seen => new Map([[URL_A, { title: "ZEC halving", cited: [CITED] }]]);
const payloadOf = (view: NarrativeView | null) => ({ narrative: flowPayload(FLOW), rationale: "", view: view && { lean: view.lean, note: view.note } });

describe("vetContrast", () => {
  test("cited evidence stays observed; code sets the agreement from the view's lean", () => {
    const v = vetContrast(OUT, seen(), payloadOf(VIEW), VIEW);
    expect(v.favours).toBe("continuation");
    expect(v.confidence).toBe("medium");
    expect(v.continuation.evidence[0]!.type).toBe("observed");
    expect(v.fade.evidence[0]!.type).toBe("hypothesis");
    expect(v.view).toMatchObject({ lean: "fade", agreement: "conflicts" });
    expect(v.view.why).toContain("funding z 2.6");
    expect(v.summary).toContain("12.45%");
  });

  test("advice and numbers found nowhere are dropped", () => {
    const v = vetContrast(OUT, seen(), payloadOf(VIEW), VIEW);
    // 1.5M is in no payload or citation; "Sell the next pop." is advice.
    expect(v.invalidates).toEqual([]);
    expect(v.confirms).toEqual(["OI keeps rising while funding cools"]);
  });

  test("no observed evidence on either side: favours unclear at low confidence", () => {
    const v = vetContrast({ ...OUT, continuation: caseOf("Zcash's halving cut issuance by 50%", "observed", "https://elsewhere.example.com/x") }, seen(), payloadOf(VIEW), VIEW);
    expect(v.continuation.evidence[0]!.type).toBe("hypothesis");
    expect(v.favours).toBe("unclear");
    expect(v.confidence).toBe("low");
    expect(v.view.agreement).toBe("mixed");
  });

  test("agreement table", () => {
    expect(agreement("continuation", "continuation")).toBe("agrees");
    expect(agreement("fade", "continuation")).toBe("conflicts");
    expect(agreement("fade", "unclear")).toBe("mixed");
    expect(agreement("unsure", "fade")).toBe("no_view");
    expect(agreement(null, "fade")).toBe("no_view");
    const v = vetContrast(OUT, seen(), payloadOf(null), null);
    expect(v.view).toEqual({ lean: null, note: "", agreement: "no_view", why: "" });
  });
});

/** Fires the hooks the Anthropic provider does, then emits `out`. */
class Provider implements LLMProvider {
  readonly id = "anthropic" as const;
  readonly model = "claude-opus-5-5";
  prompts: string[] = [];
  constructor(readonly webSearch = true, private readonly out: unknown = OUT) {}
  start(_system: string, _history: unknown[], question: string): Conversation {
    this.prompts.push(question);
    const self = this;
    return {
      async step(_tools, hooks): Promise<StepResult> {
        hooks.onServerToolCall?.({ id: "s0", name: "web_search", input: {} });
        hooks.onSearchResults?.([{ url: URL_A, title: "ZEC halving" }]);
        hooks.onCitation?.({ url: URL_A, title: null, cited_text: CITED } satisfies Citation);
        return { stop: "tool_use", toolCalls: [{ id: "t1", name: "emit", input: self.out }], usage: { input_tokens: 1000, output_tokens: 500 } };
      },
      addToolResults() {},
    };
  }
}

describe("runContrast", () => {
  test("the prompt carries our flow, the operator's view and the basket's headlines as untrusted data", async () => {
    const store = new MemoryIntelStore(() => NOW);
    await store.upsertEvents([
      { key: "n1", type: "news", title: "Zcash shielded supply hits a high", summary: null, entities: ["ZEC"], assets: ["ZEC"], magnitude: "med", sources: [{ label: "rss" }], origin: "rss", firstSeen: "2026-10-27T08:00:00.000Z", scheduledAt: null, catalyst: null, tag: "observed" },
      { key: "n2", type: "news", title: "Solana ETF flows", summary: null, entities: ["SOL"], assets: ["SOL"], magnitude: "med", sources: [{ label: "rss" }], origin: "rss", firstSeen: "2026-10-27T08:00:00.000Z", scheduledAt: null, catalyst: null, tag: "observed" },
    ] as never);
    const provider = new Provider();
    const res = await runContrast({ store, llm: llmDeps(provider, store, () => NOW), now: () => NOW }, { flow: FLOW, rationale: "ZEC +4.25% 24h", view: VIEW });
    expect(res.status).toBe("done");
    expect(res.narrativeId).toBe("privacy");
    expect(res.searches).toBe(1);
    expect(res.costUsd).toBeGreaterThan(0);
    expect(res.view.agreement).toBe("conflicts");
    const prompt = provider.prompts[0]!;
    expect(prompt).toContain("Feels crowded after a 30% month");
    expect(prompt).toContain('"stage":"crowded"');
    expect(prompt).toMatch(/<untrusted>\nZcash shielded supply hits a high\n<\/untrusted>/);
    expect(prompt).not.toContain("Solana ETF flows");
  });

  test("no hosted web search: nothing runs", async () => {
    const store = new MemoryIntelStore(() => NOW);
    const provider = new Provider(false);
    const res = await runContrast({ store, llm: llmDeps(provider, store, () => NOW), now: () => NOW }, { flow: FLOW, rationale: "", view: null });
    expect(res.status).toBe("no_web_search");
    expect(provider.prompts).toEqual([]);
  });

  test("invalid output after the retry fails closed, still billed", async () => {
    const store = new MemoryIntelStore(() => NOW);
    const res = await runContrast({ store, llm: llmDeps(new Provider(true, { nope: 1 }), store, () => NOW), now: () => NOW }, { flow: FLOW, rationale: "", view: VIEW });
    expect(res.status).toBe("failed");
    expect(res.error).toContain("invalid output after retry");
    expect(res.favours).toBe("unclear");
    expect(res.costUsd).toBeGreaterThan(0);
  });
});
