import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { AgentProposalSchema, AgentRecordSchema, type AgentProposalInput, type AgentRecord } from "../../shared/agentRecords.js";
import { EmitProvider, llmDeps } from "../intel/fixtures/emit-provider.js";
import type { LlmDeps } from "../intel/llm.js";
import type { Citation, Conversation, LLMProvider, StepResult } from "../llm/provider.js";
import { MemoryPlatformStore } from "../platform/store-memory.js";
import { detail, iso, record, T0 } from "./agent.fixture.js";
import { agentPayload, checkFalsifier, investigate, NO_PROVIDER, NO_WEB_SEARCH, recordProposal, type AgentDeps, type AgentOutput } from "./agent.js";

const URL_A = "https://news.example.com/sol-unlock";
const URL_B = "https://blog.example.org/other";

/** Answers every step with `reply(prompt)` through `emit`, after firing hosted-search hooks for URL_A (cited) and URL_B (uncited). */
class SearchProvider implements LLMProvider {
  readonly id = "anthropic" as const;
  readonly model = "scripted-search";
  calls = 0;
  constructor(
    private readonly reply: () => unknown,
    readonly webSearch = true,
    private readonly cites: Citation[] = [{ url: URL_A, title: "SOL unlock", cited_text: "The network unlocked 3% of supply on Tuesday." }],
  ) {}
  start(): Conversation {
    const self = this;
    return {
      async step(_tools, hooks): Promise<StepResult> {
        self.calls++;
        hooks.onSearchResults?.([{ url: URL_A, title: "SOL unlock" }, { url: URL_B, title: "Other" }]);
        for (const c of self.cites) hooks.onCitation?.(c);
        return { stop: "tool_use", toolCalls: [{ id: "t1", name: "emit", input: self.reply() }], usage: { input_tokens: 1, output_tokens: 1 } };
      },
      addToolResults() {},
    };
  }
}

const out = (over: Partial<AgentOutput> = {}): AgentOutput => ({
  claim: "The network unlocked 3% of supply, which hit the book.",
  layer: "forced_flow",
  direction: "long",
  assets: ["SOL", "not a ticker!"],
  falsifierLevel: 9.5,
  falsifierText: "A trade below 9.5 means the unlock was absorbed and the move was not supply.",
  sources: [
    { url: URL_A, ts: "2026-11-10T09:00:00Z", title: "model title" },
    { url: URL_B, ts: null, title: "Other" },
    { url: "http://insecure.example.com", ts: null, title: "x" },
  ],
  ...over,
});

function setup(provider: LLMProvider | null, o: { dailyCap?: number; llm?: Partial<LlmDeps> | null } = {}) {
  const store = new MemoryPlatformStore();
  const llm = o.llm === null ? null : { ...llmDeps(provider, undefined, () => new Date(T0)), ...o.llm };
  let n = 0;
  const deps: AgentDeps = { store, llm, now: () => new Date(T0), dailyCap: o.dailyCap ?? 6, inflight: new Set(), newId: () => `rec-${++n}` };
  return { store, deps };
}
const run = (deps: AgentDeps, d = detail()) => investigate(deps, { detail: d, btcMark: 60000, trigger: "manual" });

describe("investigate", () => {
  test("a vetted record: checked numbers, observed only when cited, falsifier checked against mark and σ24h", async () => {
    let seenOpen: unknown = null;
    const { store, deps } = setup(null);
    const p = new SearchProvider(() => ((seenOpen = [...store.agentRecords.values()][0]), out()));
    deps.llm = llmDeps(p, undefined, () => new Date(T0));
    const r = (await run(deps))!;
    // Written before the call returned: open, no content, provider model set.
    expect(seenOpen).toMatchObject({ status: "open", claim: "", model: "scripted-search", direction: null });
    expect(AgentRecordSchema.parse(r)).toEqual(r);
    expect(r).toMatchObject({
      coin: "SOL", status: "open", trigger: "manual", claim: "The network unlocked 3% of supply, which hit the book.", layer: "forced_flow", direction: "long",
      horizonHours: 24, assets: ["SOL"], falsifier: { level: 9.5, side: "below" }, dropped: 0, error: null, promptVersion: "moves-agent-v1",
      inputs: { window: "24h", residualPct: 6.2, residualZ: 3.1, totalPct: 7.2, markAtCreate: 10, btcAtCreate: 60000, asOf: iso(T0) },
    });
    expect(r.sources).toEqual([
      { url: URL_A, ts: "2026-11-10T09:00:00.000Z", title: "SOL unlock", observed: true },
      { url: URL_B, ts: null, title: "Other", observed: false },
    ]);
    expect(await store.listAgentRecords({ limit: 5 })).toEqual([r]);
    expect(await store.agentRunsSince(iso(T0 - 1))).toBe(1);
  });

  test("the prompt carries code numbers and wraps headlines as untrusted", async () => {
    const p = new EmitProvider(() => out());
    const { deps } = setup(p);
    await run(deps);
    expect(p.prompts[0]).toContain('"residualPct":6.2');
    expect(p.prompts[0]).toContain("<untrusted>\nSOL ecosystem fund announced\n</untrusted>");
    expect(agentPayload(detail(), 60000).falsifierBand).toEqual({ long: [8.86920, 9.90050], short: [10.1005, 11.2750] });
  });

  test("an advice line and an unbacked number are dropped and counted", async () => {
    const p = new SearchProvider(() =>
      out({ claim: "The network unlocked 3% of supply. You should sell before it dumps. Open interest jumped 47%.", falsifierText: "Below 9.5 it fails; buy the dip." }),
    );
    const { deps } = setup(p);
    const r = (await run(deps))!;
    expect(r.claim).toBe("The network unlocked 3% of supply.");
    expect(r.falsifier).toBeNull(); // its text gave advice
    expect(r.dropped).toBe(3);
    expect(r.status).toBe("open");
  });

  test("a falsifier outside [0.25σ, 3σ] or on the wrong side is dropped, the record kept", async () => {
    for (const level of [9.95, 8, 10.5]) {
      const { deps } = setup(new SearchProvider(() => out({ falsifierLevel: level })));
      const r = (await run(deps))!;
      expect([level, r.status, r.falsifier, r.claim.length > 0]).toEqual([level, "open", null, true]);
    }
    // No σ24h: nothing to check against, so no falsifier.
    const { deps } = setup(new SearchProvider(() => out()));
    const d = detail("SOL", { liq: { ...detail().liq, sigma24hPct: null } });
    expect((await run(deps, d))!.falsifier).toBeNull();
    expect(checkFalsifier(10.2, "short", 10, 4)).toEqual({ level: 10.2, side: "above" });
    expect(checkFalsifier(9.8, "short", 10, 4)).toBeNull();
    expect(checkFalsifier(9.5, null, 10, 4)).toBeNull();
  });

  test("fails closed on a schema miss: retried once, stored as failed with no content", async () => {
    const p = new SearchProvider(() => out({ layer: "vibes" as never }));
    const { deps } = setup(p);
    const r = (await run(deps))!;
    expect(p.calls).toBe(2);
    expect(r).toMatchObject({ status: "failed", claim: "", direction: null, falsifier: null, sources: [], layer: "unexplained", error: expect.stringContaining("invalid output after retry") });
  });

  test("no public cause is a valid answer: no_cause, nothing graded", async () => {
    const { deps } = setup(new SearchProvider(() => out({ claim: "", direction: "short" })));
    expect(await run(deps)).toMatchObject({ status: "no_cause", claim: "", direction: null, falsifier: null, error: null });
    // A claim that fails every check is not a cause either, and says so.
    const { deps: d2 } = setup(new SearchProvider(() => out({ claim: "Sell now." })));
    expect(await run(d2)).toMatchObject({ status: "failed", claim: "", dropped: 1, error: expect.stringContaining("failed the number or advice check") });
  });

  test("the moves cap gives `capped` before any provider call", async () => {
    const p = new SearchProvider(() => out());
    const { store, deps } = setup(p, { dailyCap: 1 });
    await store.insertAgentRecord(record({ id: "earlier", createdAt: iso(T0 - 3_600_000) }));
    await store.insertAgentRecord(record({ id: "yesterday", createdAt: iso(T0 - 86_400_000) }));
    const r = (await run(deps))!;
    expect(p.calls).toBe(0);
    expect(r).toMatchObject({ status: "capped", model: null, claim: "", error: "moves agent cap reached (1/1 today)" });
    expect(await store.agentRunsSince(iso(T0 - 12 * 3_600_000))).toBe(1); // a capped record is not a run
  });

  test("the daily LLM cap is checked before the provider call", async () => {
    const p = new SearchProvider(() => out());
    const { deps } = setup(p, { llm: { dailyCap: 0 } });
    const r = (await run(deps))!;
    expect(p.calls).toBe(0);
    expect(r).toMatchObject({ status: "capped", claim: "", error: "LLM cap reached" });
  });

  test("no provider or no web search: stored as failed, the reason in `error`", async () => {
    expect(await run(setup(null).deps)).toMatchObject({ status: "failed", model: null, error: NO_PROVIDER });
    expect(await run(setup(null, { llm: null }).deps)).toMatchObject({ status: "failed", error: NO_PROVIDER });
    const p = new SearchProvider(() => out(), false);
    expect(await run(setup(p).deps)).toMatchObject({ status: "failed", error: NO_WEB_SEARCH });
    expect(p.calls).toBe(0);
  });

  test("one call per coin in flight", async () => {
    const { deps } = setup(new SearchProvider(() => out()));
    deps.inflight.add("SOL");
    expect(await run(deps)).toBeNull();
    deps.inflight.delete("SOL");
    expect(await run(deps)).not.toBeNull();
    expect(deps.inflight.size).toBe(0);
  });
});

describe("recordProposal (the routine's path)", () => {
  const claim = "The 6.2% residual came with no news hour, which fits a supply unlock hitting the book.";
  const text = "A trade below 9.5 means the unlock was absorbed.";
  const proposal = (over: Partial<AgentProposalInput> = {}) =>
    AgentProposalSchema.parse({
      claim, layer: "forced_flow", direction: "long", assets: ["SOL", "JUP"], horizonHours: 24,
      falsifier: { level: 9.5, side: "below", text },
      sources: [{ url: URL_A, ts: "2026-11-10T09:00:00Z", title: "SOL unlock" }, { url: URL_B, title: "Other" }],
      ...over,
    });
  const propose = (deps: AgentDeps, p = proposal(), d = detail()) => recordProposal(deps, { detail: d, btcMark: 60000, proposal: p });
  const stored = async (deps: AgentDeps, p = proposal()) => {
    const r = await propose(deps, p);
    if (!r.ok) throw new Error(r.error);
    return r.record;
  };

  test("parity: one proposal through investigate() and the routine gives the same record but trigger, model and observed", async () => {
    const p = proposal();
    const viaProvider = (await run(setup(new SearchProvider(() => out({ claim, assets: p.assets, falsifierLevel: 9.5, falsifierText: text, sources: [
      { url: URL_A, ts: "2026-11-10T09:00:00Z", title: "SOL unlock" }, { url: URL_B, ts: null, title: "Other" },
    ] }))).deps))!;
    const viaRoutine = await stored(setup(null).deps, p);
    const strip = (r: AgentRecord) => ({ ...r, trigger: null, model: null, sources: r.sources.map(({ observed: _, ...s }) => s) });
    expect(strip(viaRoutine)).toEqual(strip(viaProvider));
    expect(viaProvider).toMatchObject({ status: "open", trigger: "manual", model: "scripted-search", dropped: 0, falsifier: { level: 9.5, side: "below", text } });
    expect(viaRoutine).toMatchObject({ status: "open", trigger: "routine", model: "routine", assets: ["SOL", "JUP"] });
    expect(viaProvider.sources.map((s) => s.observed)).toEqual([true, false]);
    expect(viaRoutine.sources.map((s) => s.observed)).toEqual([false, false]); // the server saw no provider citation
    expect(AgentRecordSchema.parse(viaRoutine)).toEqual(viaRoutine);
  });

  test("code stamps the inputs; an unbacked number or advice is dropped; a source's own numbers are not evidence here", async () => {
    const { store, deps } = setup(null);
    const r = await stored(deps, proposal({ claim: `${claim} Open interest jumped 47%. Buy it.` }));
    expect(r).toMatchObject({ claim, dropped: 2, inputs: { window: "24h", residualPct: 6.2, residualZ: 3.1, totalPct: 7.2, markAtCreate: 10, btcAtCreate: 60000, asOf: iso(T0) }, horizonHours: 24, promptVersion: "moves-agent-v1" });
    expect(await store.listAgentRecords({ limit: 5 })).toEqual([r]);
    expect(await store.agentRunsSince(iso(T0 - 1))).toBe(1); // a routine record counts against MOVES_AGENT_DAILY
  });

  test("no public cause is stored as no_cause, never graded; a falsifier outside the band is dropped", async () => {
    expect(await stored(setup(null).deps, proposal({ claim: "", layer: "unexplained", direction: null, falsifier: null }))).toMatchObject({ status: "no_cause", claim: "", direction: null, falsifier: null, error: null });
    expect(await stored(setup(null).deps, proposal({ falsifier: { level: 8, side: "below", text } }))).toMatchObject({ status: "open", falsifier: null });
  });

  test("fails closed and writes nothing at the cap (routine runs count) or when every claim sentence is rejected", async () => {
    const { store, deps } = setup(null, { dailyCap: 1 });
    await store.insertAgentRecord(record({ id: "earlier", trigger: "routine", model: "routine", createdAt: iso(T0 - 3_600_000) }));
    expect(await propose(deps)).toEqual({ ok: false, status: 429, error: "moves agent cap reached (1/1 today)" });
    const s2 = setup(null);
    const r = await propose(s2.deps, proposal({ claim: "Open interest jumped 47%. Sell now." }));
    expect(r).toMatchObject({ ok: false, status: 422 });
    expect(await s2.store.listAgentRecords({ limit: 5 })).toEqual([]);
    expect(await store.listAgentRecords({ limit: 5 })).toHaveLength(1);
  });

  test("the proposal schema takes only what a model may propose", () => {
    for (const bad of [
      { inputs: { markAtCreate: 1 } }, { status: "graded" }, { model: "x" }, { trigger: "manual" }, { grade: null },
      { falsifier: { level: 11, side: "above", text } }, // a long is falsified below its level
      { direction: null }, // a falsifier needs a direction
      { horizonHours: 12 }, { sources: [{ url: "http://insecure.example.com", title: "x" }] }, { sources: [{ url: URL_A, title: "x", observed: true }] },
    ]) expect(AgentProposalSchema.safeParse({ ...proposal(), ...bad }).success).toBe(false);
  });
});

describe("the agent cannot reach approval, orders or the desk", () => {
  test("no agent-watch module imports approve, order, desk or platform route code", () => {
    for (const f of ["agent.ts", "agentGrade.ts", "agentLoop.ts", "agentRoutes.ts", "jobs.ts", "stored.ts", "triage.ts", "routineCli.ts", "../../../scripts/moves-routine.ts"]) {
      const src = readFileSync(new URL(`./${f}`, import.meta.url), "utf8");
      const imports = [...src.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1]!);
      expect(imports.length).toBeGreaterThan(0);
      expect({ f, bad: imports.filter((p) => /desk|order|approve|routes\/platform|platform\/reconcile|platform\/opportunity/i.test(p)) }).toEqual({ f, bad: [] });
    }
  });

  test("the agent's deps type holds a store slice of record methods only", async () => {
    const { deps } = setup(new SearchProvider(() => out()));
    const used = new Set<string>();
    const spy = new Proxy(deps.store, { get: (t, k) => (typeof Reflect.get(t, k) === "function" && used.add(String(k)), Reflect.get(t, k)) });
    await run({ ...deps, store: spy });
    expect([...used].sort()).toEqual(["agentRunsSince", "insertAgentRecord", "updateAgentRecord"]);
    used.clear();
    await recordProposal({ ...deps, store: spy }, { detail: detail("WIF"), btcMark: 60000, proposal: AgentProposalSchema.parse({ claim: "", layer: "unexplained", direction: null }) });
    expect([...used].sort()).toEqual(["agentRunsSince", "insertAgentRecord"]);
  });
});
