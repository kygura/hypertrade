import { describe, expect, test } from "bun:test";
import type { Citation, Conversation, LLMProvider, StepOptions, StepResult } from "../llm/provider.js";
import type { FlowFlag } from "../../shared/intel.js";
import { llmDeps } from "./fixtures/emit-provider.js";
import { MemoryIntelStore } from "./store.js";
import { NO_CAUSE, RESEARCH_DEADLINE_MS, RESEARCH_NO_WEB_SEARCH, runResearch, strictNumbers, type ResearchDeps } from "./research.js";

// Fixture tests, no network: a scripted provider that fires the same hooks the
// Anthropic provider does (server tool call, search results, citations).

const T0 = new Date("2026-10-14T12:00:00Z");
const URL_A = "https://news.example.com/jito-exploit";
const RESULTS = [{ url: URL_A, title: "Jito exploit drains $12M from restaking pool" }];
const CITES: Citation[] = [{ url: URL_A, title: null, cited_text: "Attackers drained $12M from the Jito restaking pool on Tuesday" }];
const GOOD_CLAIM = "Attackers drained $12M from the Jito pool";

interface Script {
  emit: unknown;
  results?: { url: string; title: string | null }[];
  cites?: Citation[];
  searches?: number;
}

/** One script per step (the last repeats). */
class SearchProvider implements LLMProvider {
  readonly id = "anthropic" as const;
  readonly model = "claude-opus-5-5";
  prompts: string[] = [];
  opts: StepOptions[] = [];
  private calls = 0;
  private readonly scripts: Script[];
  constructor(
    script: Script | Script[],
    readonly webSearch = true,
  ) {
    this.scripts = Array.isArray(script) ? script : [script];
  }
  start(_system: string, _history: unknown[], question: string): Conversation {
    this.prompts.push(question);
    const self = this;
    return {
      async step(_tools, hooks, opts): Promise<StepResult> {
        self.opts.push(opts);
        const s = self.scripts[Math.min(self.calls++, self.scripts.length - 1)]!;
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

async function setup(script: Script | Script[], opts: { webSearch?: boolean; dailyUsd?: number; clock?: () => Date; exposure?: ResearchDeps["exposure"] } = {}) {
  const clock = opts.clock ?? (() => T0);
  const store = new MemoryIntelStore(clock);
  await store.insertSnapshots([
    { asset: "SOL", ts: "2026-10-14T11:30:00.000Z", price: 150.5, vol24h: null, funding: 0.0001, oiUsd: 2.5e9, premium: null, basis: null, depthBid1: null, depthAsk1: null, depthBid2: null, depthAsk2: null, spreadBps: null },
  ]);
  const provider = new SearchProvider(script, opts.webSearch ?? true);
  const llm = { ...llmDeps(provider, store, clock), dailyUsd: opts.dailyUsd };
  const deps: ResearchDeps = { store, llm, exposure: opts.exposure ?? (async () => [{ asset: "SOL", side: "long", notionalUsd: 1500 }]), now: clock };
  return { store, provider, deps };
}

const input = { question: "Why did SOL drop today?", asset: "SOL", trigger: "manual" as const, flag };
const emit = (over: Record<string, unknown>) => ({ explanation: "", evidence: [], confidence: "medium", openQuestions: [], ...over });
const observed = (claim = GOOD_CLAIM, url: string | null = URL_A) => ({ claim, url, ts: null, type: "observed" });

describe("strictNumbers", () => {
  test("value, sign and unit must all match; scale words fold into the value; dates are skipped", () => {
    expect([...strictNumbers("-5% on Oct 14 at 12:30")]).toEqual(["-5%"]);
    expect(strictNumbers("5%").has("-5%")).toBe(false);
    expect(strictNumbers("5 bps").has("5%")).toBe(false);
    expect(strictNumbers("$12M").has("12000000")).toBe(true);
    expect(strictNumbers("12 million").has("12000000")).toBe(true);
    expect(strictNumbers("12.4M").has("12000000")).toBe(false); // no rounding tolerance
    expect(strictNumbers("−3.5%").has("-3.5%")).toBe(true); // unicode minus
    expect(strictNumbers("24h window").size).toBe(0);
  });
});

describe("runResearch", () => {
  test("found: observed claim backed by a citation survives, the search budget is passed per call", async () => {
    const { deps, provider, store } = await setup({
      searches: 3,
      emit: emit({
        explanation: "An exploit drained $12M from a restaking pool. SOL is at 150.5.",
        evidence: [{ ...observed(), ts: "2026-10-14T08:00:00Z" }],
        confidence: "high",
        openQuestions: ["Did the team confirm the loss?"],
      }),
    });
    const r = (await runResearch(deps, input))!;
    expect(r).toMatchObject({ status: "found", trigger: "manual", flagId: flag.id, asset: "SOL", confidence: "high", searches: 3, model: "claude-opus-5-5" });
    expect(r.evidence).toEqual([{ claim: GOOD_CLAIM, url: URL_A, ts: "2026-10-14T08:00:00.000Z", type: "observed" }]);
    expect(r.costUsd).toBeCloseTo((1000 * 4 + 500 * 20) / 1e6 + 3 * 0.01, 8); // tokens + search fees
    expect(provider.opts[0]).toMatchObject({ webSearch: true, maxUses: 8 });
    expect(provider.prompts[0]).toContain("<untrusted>");
    expect((await store.researchForFlag(flag.id))?.id).toBe(r.id);
  });

  test("no_cause: the fixed sentence plus what the payload actually had", async () => {
    const { deps } = await setup({ emit: emit({ explanation: "Maybe something happened." }), searches: 2 });
    const r = (await runResearch(deps, input))!;
    expect(r.status).toBe("no_cause");
    expect(r.explanation).toBe(`${NO_CAUSE} Checked: 2 web searches, latest snapshot, flag numbers, exposure.`);
    expect(r.evidence).toEqual([]);
  });

  test("no_cause with no asset and no flag lists only what exists", async () => {
    const { deps } = await setup({ emit: emit({}) }, { exposure: async () => [] });
    const r = (await runResearch(deps, { question: "What moved the market today?", asset: null, trigger: "manual" }))!;
    expect(r.explanation).toBe("No public cause found. Checked: 1 web search.");
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

  test("hypotheses alone are no_cause but stay as evidence; an invented URL is a hypothesis without its url", async () => {
    const { deps } = await setup({
      emit: emit({ explanation: "A pool was drained.", evidence: [observed("A pool was drained", "https://invented.example.org/x")], confidence: "high" }),
    });
    const r = (await runResearch(deps, input))!;
    expect(r.status).toBe("no_cause");
    expect(r.confidence).toBe("low");
    expect(r.evidence).toEqual([{ claim: "A pool was drained", url: null, ts: null, type: "hypothesis" }]);
  });

  test("the title alone never makes a claim observed: it needs a citation for the url", async () => {
    const { deps } = await setup({ cites: [], emit: emit({ explanation: "Exploit.", evidence: [observed("Jito exploit drains $12M from restaking pool")] }) });
    const r = (await runResearch(deps, input))!;
    expect(r.status).toBe("no_cause");
    expect(r.evidence).toEqual([{ claim: "Jito exploit drains $12M from restaking pool", url: URL_A, ts: null, type: "hypothesis" }]);
  });

  test("a citation for a URL the provider never returned is ignored", async () => {
    const { deps } = await setup({ cites: [{ url: "https://other.example.com/x", title: null, cited_text: GOOD_CLAIM }], emit: emit({ evidence: [observed(GOOD_CLAIM, "https://other.example.com/x")] }) });
    const r = (await runResearch(deps, input))!;
    expect(r.evidence.map((e) => [e.type, e.url])).toEqual([["hypothesis", null]]);
  });

  test("fewer than half of the content words in the cited text downgrades the claim", async () => {
    const { deps } = await setup({ emit: emit({ evidence: [observed("Treasury multisig compromised through phishing, $12M drained")] }) });
    const r = (await runResearch(deps, input))!;
    expect(r.evidence.map((e) => e.type)).toEqual(["hypothesis"]);
  });

  test("a number missing from the cited text downgrades (url kept); one found nowhere drops the claim", async () => {
    const { deps } = await setup({
      emit: emit({
        explanation: "A pool was drained.",
        evidence: [
          observed(GOOD_CLAIM),
          observed("SOL traded at 150.5 when the Jito pool was drained"), // 150.5 is in our payload, not in the cited text
          observed("The Jito pool lost $99M"), // in neither
        ],
      }),
    });
    const r = (await runResearch(deps, input))!;
    expect(r.status).toBe("found");
    expect(r.evidence.map((e) => [e.claim, e.type, e.url])).toEqual([
      [GOOD_CLAIM, "observed", URL_A],
      ["SOL traded at 150.5 when the Jito pool was drained", "hypothesis", URL_A],
    ]);
  });

  test("sign and unit must match exactly: a cited 5% does not back -5% or 5 bps", async () => {
    const cites = [{ url: URL_A, title: null, cited_text: "Jito pool deposits fell 5% on Tuesday" }];
    const { deps } = await setup({ cites, emit: emit({ evidence: [observed("Jito pool deposits fell -5% on Tuesday"), observed("Jito pool deposits fell 5 bps on Tuesday"), observed("Jito pool deposits fell 5% on Tuesday")] }) });
    const r = (await runResearch(deps, input))!;
    expect(r.evidence.map((e) => e.type)).toEqual(["hypothesis", "hypothesis", "observed"]);
  });

  test("with no result URLs exposed every claim is a hypothesis", async () => {
    const { deps } = await setup({ results: [], emit: emit({ evidence: [observed("Attackers drained funds")] }) });
    const r = (await runResearch(deps, input))!;
    expect(r.evidence.map((e) => e.type)).toEqual(["hypothesis"]);
  });

  test("an explanation number that is in neither the payload nor a surviving observed claim is dropped", async () => {
    const { deps } = await setup({ emit: emit({ explanation: "An exploit drained $12M. SOL fell 77% on it. SOL is at 150.5.", evidence: [observed()] }) });
    const r = (await runResearch(deps, input))!;
    expect(r.explanation).toBe("An exploit drained $12M. SOL is at 150.5.");
  });

  test("an emptied explanation with observed evidence is neutral, not no_cause", async () => {
    const { deps } = await setup({ emit: emit({ explanation: "SOL fell 77%.", evidence: [observed()] }) });
    const r = (await runResearch(deps, input))!;
    expect(r.status).toBe("found");
    expect(r.explanation).toContain("See the evidence below");
  });

  test("advice lines are dropped from claims, explanation and open questions", async () => {
    const { deps } = await setup({
      emit: emit({
        explanation: "An exploit drained $12M. Sell the rip. Go long on the bounce.",
        evidence: [observed(), { claim: "Buy SOL now", url: null, ts: null, type: "hypothesis" }],
        openQuestions: ["You should sell SOL?", "Take profit here?", "Was the loss confirmed?", "Did SOL fall 77%?"],
      }),
    });
    const r = (await runResearch(deps, input))!;
    expect(r.explanation).toBe("An exploit drained $12M.");
    expect(r.evidence.map((e) => e.claim)).toEqual([GOOD_CLAIM]);
    expect(r.openQuestions).toEqual(["Was the loss confirmed?"]); // the 77% question fails the number check
  });

  test("the 8-search budget covers the retry; failed runs keep and bill their spend", async () => {
    const { deps, provider, store } = await setup([{ emit: { nope: true }, searches: 6 }, { emit: { nope: true }, searches: 2 }]);
    const r = (await runResearch(deps, input))!;
    expect(provider.opts.map((o) => [o.webSearch, o.maxUses])).toEqual([[true, 8], [true, 2]]); // the retry gets what is left
    expect(r).toMatchObject({ status: "failed", searches: 8, model: "claude-opus-5-5" });
    expect(r.costUsd).toBeCloseTo((2000 * 4 + 1000 * 20) / 1e6 + 8 * 0.01, 8);
    expect(await store.usageSince(new Date(0))).toHaveLength(1); // billed once, in a row of its own
  });

  test("an exhausted budget turns web search off for the retry", async () => {
    const { deps, provider } = await setup([{ emit: { nope: true }, searches: 8 }, { emit: emit({}), searches: 0 }]);
    await runResearch(deps, input);
    expect(provider.opts.map((o) => [o.webSearch, o.maxUses])).toEqual([[true, 8], [false, 0]]);
  });

  test("a throwing read stores a failed row and leaves no running row", async () => {
    const { deps, store } = await setup({ emit: emit({}) }, { exposure: async () => Promise.reject(new Error("positions down")) });
    const r = (await runResearch(deps, input))!;
    expect(r).toMatchObject({ status: "failed", explanation: "positions down", searches: 0 });
    expect(store.research.map((x) => x.status)).toEqual(["failed"]);
  });

  test("the running lock blocks a second run, then goes stale after deadline + 15s", async () => {
    let now = T0;
    const clock = () => now;
    const { deps, store } = await setup({ emit: emit({}) }, { clock });
    const held = await store.acquireResearch({ trigger: "manual", asset: "SOL", question: "q", status: "running", explanation: "", evidence: [], confidence: "low", openQuestions: [], searches: 0, costUsd: 0, model: "" }, 3_600_000);
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
