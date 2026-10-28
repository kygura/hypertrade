import { describe, expect, test } from "bun:test";
import type { NarrativeFlow, NarrativeView } from "../../shared/intel.js";
import type { SectorsData } from "../../shared/types.js";
import type { Citation, Conversation, LLMProvider, StepResult } from "../llm/provider.js";
import { llmDeps } from "./fixtures/emit-provider.js";
import { mapperDeps, position } from "./fixtures/mapper-deps.js";
import { CONTRAST_DEADLINE_MS, CONTRASTS_SETTING, VIEWS_SETTING } from "./narrativeContrast.js";
import {
  AUTO_SETTING,
  contrastCandidates,
  narrativeAutoContrast,
  narrativeStageAlerts,
  STAGE_CONFIRM_MS,
  STAGE_COOLDOWN_MS,
  STAGE_RETURN_MS,
  STAGES_SETTING,
  stageLine,
  stageTransitions,
  type NarrativeWatchDeps,
  type StageStates,
} from "./narrativeWatch.js";
import { AUTO_RESEARCH_MARGIN_MS } from "./research.js";

const NOW = new Date("2026-10-27T12:00:00Z");
const ISO = NOW.toISOString();
const H = 3_600_000;
const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString();

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
const flowOf = (o: Partial<NarrativeFlow> = {}): NarrativeFlow => ({ ...FLOW, ...o, htf: { ...FLOW.htf, ...o.htf } });
const view = (lean: NarrativeView["lean"]): NarrativeView => ({ lean, note: "", updatedAt: ISO });
const state = (stage: NarrativeFlow["stage"], o: Partial<StageStates[string]> = {}): StageStates[string] => ({ stage, since: at(-48 * H), alertedAt: null, pending: null, ...o });

describe("stageTransitions", () => {
  test("first sight is recorded silently; unknown changes nothing (a pending stage included)", () => {
    const first = stageTransitions({}, [flowOf()], ISO);
    expect(first).toEqual({ next: { privacy: { stage: "crowded", since: ISO, alertedAt: null, pending: null } }, changes: [] });
    const prev: StageStates = { privacy: state("emerging", { pending: { stage: "crowded", since: at(-H), runs: 1 } }) };
    expect(stageTransitions(prev, [flowOf({ stage: "unknown" })], ISO)).toEqual({ next: prev, changes: [] });
    expect(stageTransitions({}, [flowOf({ stage: "unknown" })], ISO)).toEqual({ next: {}, changes: [] });
  });

  test("a different stage holds two runs and 2 h before it is committed; the committed stage returning clears it; a third stage restarts it", () => {
    const prev: StageStates = { privacy: state("emerging") };
    const r1 = stageTransitions(prev, [flowOf()], at(-STAGE_CONFIRM_MS));
    expect(r1.changes).toEqual([]);
    expect(r1.next.privacy).toEqual({ ...prev.privacy!, pending: { stage: "crowded", since: at(-STAGE_CONFIRM_MS), runs: 1 } });
    const early = stageTransitions(r1.next, [flowOf()], at(-STAGE_CONFIRM_MS + 60_000)); // second run, but the stage is too young
    expect(early.changes).toEqual([]);
    expect(early.next.privacy!.pending).toEqual({ stage: "crowded", since: at(-STAGE_CONFIRM_MS), runs: 2 });
    const r2 = stageTransitions(r1.next, [flowOf()], ISO);
    expect(r2.changes).toEqual([{ id: "privacy", from: "emerging", to: "crowded", since: at(-STAGE_CONFIRM_MS), alert: true }]);
    expect(r2.next.privacy).toEqual({ stage: "crowded", since: at(-STAGE_CONFIRM_MS), alertedAt: ISO, pending: null, left: { stage: "emerging", at: ISO } });
    expect(stageTransitions(r1.next, [flowOf({ stage: "emerging" })], ISO).next.privacy).toEqual(prev.privacy!);
    expect(stageTransitions(r1.next, [flowOf({ stage: "fading" })], ISO).next.privacy!.pending).toEqual({ stage: "fading", since: ISO, runs: 1 });
  });

  const pending = { stage: "crowded" as const, since: at(-STAGE_CONFIRM_MS), runs: 1 };

  test("inside the 12 h cooldown the change is committed silently and alertedAt is kept", () => {
    const hot: StageStates = { privacy: state("emerging", { alertedAt: at(-STAGE_COOLDOWN_MS + 60_000), pending }) };
    const r = stageTransitions(hot, [flowOf()], ISO);
    expect(r.changes[0]!.alert).toBe(false);
    expect(r.next.privacy).toEqual({ stage: "crowded", since: at(-STAGE_CONFIRM_MS), alertedAt: hot.privacy!.alertedAt, pending: null, left: { stage: "emerging", at: ISO } });
    const cold: StageStates = { privacy: state("emerging", { alertedAt: at(-STAGE_COOLDOWN_MS), pending }) };
    expect(stageTransitions(cold, [flowOf()], ISO).changes[0]!.alert).toBe(true);
  });

  test("returning to the stage left less than 24 h ago is committed silently; rows without `left` still load", () => {
    const recent: StageStates = { privacy: state("emerging", { pending, left: { stage: "crowded", at: at(-STAGE_RETURN_MS + 60_000) } }) };
    expect(stageTransitions(recent, [flowOf()], ISO).changes[0]!.alert).toBe(false);
    const old: StageStates = { privacy: state("emerging", { pending, left: { stage: "crowded", at: at(-STAGE_RETURN_MS) } }) };
    expect(stageTransitions(old, [flowOf()], ISO).changes[0]!.alert).toBe(true);
    const other: StageStates = { privacy: state("emerging", { pending, left: { stage: "quiet", at: at(-60_000) } }) };
    expect(stageTransitions(other, [flowOf()], ISO).changes[0]!.alert).toBe(true);
    expect(stageTransitions({ privacy: state("emerging", { pending }) }, [flowOf()], ISO).changes[0]!.alert).toBe(true);
  });

  test("a narrative flapping crowded ↔ expanding on a threshold for two days alerts once", () => {
    let st: StageStates = {};
    const alerts: string[] = [];
    for (let h = 0; h <= 48; h++) {
      const stage = Math.floor(h / 6) % 2 ? "expanding" : "crowded";
      const r = stageTransitions(st, [flowOf({ stage })], at(h * H));
      st = r.next;
      for (const c of r.changes) if (c.alert) alerts.push(`${h}h ${c.from}→${c.to}`);
    }
    expect(alerts).toEqual(["8h crowded→expanding"]);
    expect(st.privacy).toMatchObject({ stage: "expanding", pending: { stage: "crowded", runs: 1 } });
  });

  test("a narrative gone from the sector file is dropped", () => {
    expect(stageTransitions({ old: state("quiet") }, [flowOf()], ISO).next).toEqual({ privacy: { stage: "crowded", since: ISO, alertedAt: null, pending: null } });
  });
});

test("stageLine: signed pp and %, plain z, -- for a missing number", () => {
  expect(stageLine(flowOf(), "emerging")).toBe("Privacy: emerging → crowded · 7d vs BTC +11.9 pp, OI 7d +18.2%, funding z 2.6");
  expect(stageLine(flowOf({ stage: "fading", htf: { relBtc7d: -3.25, oiPct7d: null, fundingZ: -1.04 } as NarrativeFlow["htf"] }), "expanding")).toBe(
    "Privacy: expanding → fading · 7d vs BTC -3.3 pp, OI 7d --, funding z -1.0",
  );
});

test("contrastCandidates: a view the flow moves against, at flowScore ≥ 2.5, strongest first", () => {
  const flows = [
    flowOf({ id: "a", alignment: "against", flowScore: 2.6 }),
    flowOf({ id: "b", alignment: "with", flowScore: 3.1 }),
    flowOf({ id: "c", alignment: "with", flowScore: 2.8 }), // continuation with the move: nothing to test
    flowOf({ id: "d", alignment: "against", flowScore: 2.4 }), // too weak
    flowOf({ id: "e", alignment: "against", flowScore: null }),
    flowOf({ id: "f", alignment: "against", flowScore: 4 }), // unsure
    flowOf({ id: "g", alignment: "against", flowScore: 4 }), // no view
    flowOf({ id: "h", alignment: "none", flowScore: 4 }),
  ];
  const views = { a: view("continuation"), b: view("fade"), c: view("continuation"), d: view("continuation"), e: view("continuation"), f: view("unsure"), h: view("fade") };
  expect(contrastCandidates(flows, views).map((f) => f.id)).toEqual(["b", "a"]);
});

const SECTORS: SectorsData = {
  generated_at: "2026-10-27T06:00:00Z",
  sectors: [{ id: "privacy", label: "Privacy", mindshare_score: 0.5, momentum: 0.2, rationale: "ZEC +4.25% 24h", tokens: ["ZEC", "XMR"], sources: [] }],
  rotations: [],
};

function setup(o: { flows?: NarrativeFlow[]; positions?: string[]; watched?: string[]; provider?: LLMProvider | null; env?: Record<string, string>; dailyCap?: number } = {}) {
  const clock = { now: NOW };
  const base = mapperDeps({ provider: o.provider ?? null, positions: (o.positions ?? []).map((a) => position(a, "long", 10_000)), watched: o.watched, clock });
  const llm = o.dailyCap == null ? base.llm : { ...base.llm, dailyCap: o.dailyCap };
  const deps: NarrativeWatchDeps = { ...base, llm, env: o.env ?? {}, sectors: () => SECTORS, flows: async () => o.flows ?? [flowOf()] };
  return { deps, store: base.store, notifier: base.notifier, clock };
}

describe("narrativeStageAlerts", () => {
  const pendingCrowded = (): StageStates => ({ privacy: state("emerging", { pending: { stage: "crowded", since: at(-2 * H), runs: 1 } }) });

  test("a committed change on a held token pushes an observed line with the flow numbers", async () => {
    const { deps, store, notifier } = setup({ positions: ["ZEC"] });
    await store.setSetting(STAGES_SETTING, pendingCrowded());
    const r = await narrativeStageAlerts(deps, NOW);
    expect(r.errors).toEqual([]);
    expect(r.committed).toBe(1);
    expect(r.alerts).toHaveLength(1);
    expect(r.alerts[0]).toMatchObject({
      kind: "narrative",
      asset: "privacy",
      ref: `stage:privacy:crowded:${at(-2 * H)}`,
      eventType: "stage_crowded",
      materiality: 1,
      route: "push",
      line: { tag: "observed", text: "Privacy: emerging → crowded · 7d vs BTC +11.9 pp, OI 7d +18.2%, funding z 2.6", source: { label: "snapshot", url: "/sectors" }, ts: ISO },
    });
    expect(notifier.sent).toHaveLength(1);
    expect(notifier.sent[0]!.body).toContain("Privacy: emerging → crowded");
    expect(notifier.sent[0]!.body).toContain("https://app.example.com/sectors");
    expect((await store.getSetting<StageStates>(STAGES_SETTING))!.privacy).toEqual({ stage: "crowded", since: at(-2 * H), alertedAt: ISO, pending: null, left: { stage: "emerging", at: ISO } });
  });

  test("a view on the narrative is focus too; nothing held, watched or viewed batches at 0.2", async () => {
    const viewed = setup();
    await viewed.store.setSetting(STAGES_SETTING, pendingCrowded());
    await viewed.store.setSetting(VIEWS_SETTING, { privacy: view("fade") });
    expect((await narrativeStageAlerts(viewed.deps, NOW)).alerts[0]).toMatchObject({ materiality: 1, route: "push" });

    const cold = setup();
    await cold.store.setSetting(STAGES_SETTING, pendingCrowded());
    const r = await narrativeStageAlerts(cold.deps, NOW);
    expect(r.alerts[0]).toMatchObject({ materiality: 0.2, route: "batch" });
    expect(cold.notifier.sent).toEqual([]);
  });

  test("first sight and an unconfirmed change store state and alert nothing", async () => {
    const { deps, store, notifier } = setup({ positions: ["ZEC"] });
    expect(await narrativeStageAlerts(deps, NOW)).toEqual({ alerts: [], committed: 0, errors: [] });
    await store.setSetting(STAGES_SETTING, { privacy: state("emerging") });
    expect((await narrativeStageAlerts(deps, NOW)).alerts).toEqual([]);
    expect((await store.getSetting<StageStates>(STAGES_SETTING))!.privacy!.pending).toEqual({ stage: "crowded", since: ISO, runs: 1 });
    expect(notifier.sent).toEqual([]);
  });

  test("a run that crashed after pushing cannot push the same change again (the ref dedupes)", async () => {
    const { deps, store, notifier } = setup({ positions: ["ZEC"] });
    await store.setSetting(STAGES_SETTING, pendingCrowded());
    await narrativeStageAlerts(deps, NOW);
    await store.setSetting(STAGES_SETTING, pendingCrowded()); // the state write was lost
    const again = await narrativeStageAlerts(deps, new Date(NOW.getTime() + 15 * 60_000));
    expect(again).toEqual({ alerts: [], committed: 1, errors: [] });
    expect(notifier.sent).toHaveLength(1);
    expect(await store.listAlerts({ kind: "narrative", limit: 10 })).toHaveLength(1);
  });

  test("a throwing insert leaves the change pending, so the next run commits it again and alerts", async () => {
    const { deps, store, notifier } = setup({ positions: ["ZEC"] });
    await store.setSetting(STAGES_SETTING, pendingCrowded());
    const insert = store.insertAlert.bind(store);
    store.insertAlert = () => Promise.reject(new Error("db down"));
    const r = await narrativeStageAlerts(deps, NOW);
    expect(r).toEqual({ alerts: [], committed: 1, errors: ["privacy: db down"] });
    expect(await store.getSetting<StageStates>(STAGES_SETTING)).toEqual(pendingCrowded());
    store.insertAlert = insert;
    const again = await narrativeStageAlerts(deps, new Date(NOW.getTime() + 15 * 60_000));
    expect(again.alerts).toHaveLength(1);
    expect(notifier.sent).toHaveLength(1);
    expect((await store.getSetting<StageStates>(STAGES_SETTING))!.privacy!.stage).toBe("crowded");
  });

  test("a push that reached no channel is re-routed to the next brief; a failed flow load is an error, not a throw", async () => {
    const { deps, store, notifier } = setup({ positions: ["ZEC"] });
    notifier.send = async () => [];
    await store.setSetting(STAGES_SETTING, pendingCrowded());
    const r = await narrativeStageAlerts(deps, NOW);
    expect(r.alerts[0]!.route).toBe("batch");
    expect((await store.listAlerts({ route: "batch", limit: 10 })).map((a) => a.asset)).toEqual(["privacy"]);
    const broken = setup();
    broken.deps.flows = () => Promise.reject(new Error("snapshots unavailable"));
    expect(await narrativeStageAlerts(broken.deps, NOW)).toEqual({ alerts: [], committed: 0, errors: ["snapshots unavailable"] });
  });
});

// ─── automatic contrast ───

const URL_A = "https://news.example.com/zec-halving";
const CITED = "Zcash's halving cut issuance by 50% in November";
const OUT = {
  summary: "The evidence leans toward continuation.",
  favours: "continuation" as const,
  confidence: "medium" as const,
  continuation: { case: "Supply is shrinking.", evidence: [{ claim: "Zcash's halving cut issuance by 50%", url: URL_A, ts: null, type: "observed" as const }] },
  fade: { case: "Late longs may unwind.", evidence: [] },
  viewWhy: "Funding is hot, but supply is shrinking.",
  confirms: [],
  invalidates: [],
  openQuestions: [],
};

/** Fires the hooks the Anthropic provider does, then emits OUT. */
class Provider implements LLMProvider {
  readonly id = "anthropic" as const;
  readonly model = "claude-opus-5-5";
  prompts: string[] = [];
  constructor(readonly webSearch = true) {}
  start(_system: string, _history: unknown[], question: string): Conversation {
    this.prompts.push(question);
    return {
      async step(_tools, hooks): Promise<StepResult> {
        hooks.onServerToolCall?.({ id: "s0", name: "web_search", input: {} });
        hooks.onSearchResults?.([{ url: URL_A, title: "ZEC halving" }]);
        hooks.onCitation?.({ url: URL_A, title: null, cited_text: CITED } satisfies Citation);
        return { stop: "tool_use", toolCalls: [{ id: "t1", name: "emit", input: OUT }], usage: { input_tokens: 1000, output_tokens: 500 } };
      },
      addToolResults() {},
    };
  }
}

describe("narrativeAutoContrast", () => {
  const AGAINST = flowOf({ alignment: "against" });
  const ENOUGH = CONTRAST_DEADLINE_MS + AUTO_RESEARCH_MARGIN_MS;
  const run = (deps: NarrativeWatchDeps, left: () => number = () => 200_000) => narrativeAutoContrast(deps, { left });

  test("a done result is stored as the latest contrast and raises one pushed hypothesis alert; the narrative is not run again that day", async () => {
    const provider = new Provider();
    const { deps, store, notifier } = setup({ provider, flows: [AGAINST] });
    await store.setSetting(VIEWS_SETTING, { privacy: view("continuation") });
    const r = await run(deps);
    expect(r).toEqual({ ran: 1, statuses: { done: 1, failed: 0 }, stopped: "none", errors: [] });
    expect(provider.prompts[0]).toContain("ZEC +4.25% 24h"); // the sector's rationale
    const stored = (await store.getSetting<Record<string, { status: string; id: string; favours: string }>>(CONTRASTS_SETTING))!.privacy!;
    expect(stored).toMatchObject({ status: "done", favours: "continuation" });
    const [alert] = await store.listAlerts({ kind: "narrative", limit: 10 });
    expect(alert).toMatchObject({
      asset: "privacy",
      ref: `contrast:${stored.id}`,
      eventType: "contrast_continuation",
      materiality: 1,
      route: "push",
      line: { tag: "hypothesis", text: "Privacy: 6h long build (z 2.9) against the 7d move · your view: continuation · contrast favours continuation (medium confidence, agrees with your view)" },
    });
    expect(notifier.sent).toHaveLength(1);
    expect(await store.getSetting<unknown>(AUTO_SETTING)).toEqual({ day: "2026-10-27T00:00:00.000Z", n: 1, ids: ["privacy"] });
    expect(await run(deps)).toMatchObject({ ran: 0, stopped: "none" });
    expect(provider.prompts).toHaveLength(1);
  });

  test("the same read the next day is stored again but not pinged again; a changed read is", async () => {
    const provider = new Provider();
    const { deps, store, clock } = setup({ provider, flows: [AGAINST] });
    await store.setSetting(VIEWS_SETTING, { privacy: view("continuation") });
    const first = (await run(deps), (await store.getSetting<Record<string, { id: string }>>(CONTRASTS_SETTING))!.privacy!.id);
    clock.now = new Date("2026-10-28T12:00:00Z");
    expect(await run(deps)).toMatchObject({ ran: 1, statuses: { done: 1 } });
    const second = (await store.getSetting<Record<string, { id: string }>>(CONTRASTS_SETTING))!.privacy!.id;
    expect(second).not.toBe(first);
    expect(await store.listAlerts({ kind: "narrative", limit: 10 })).toHaveLength(1);
    await store.setSetting(VIEWS_SETTING, { privacy: view("fade") }); // same favours, agreement now conflicts
    clock.now = new Date("2026-10-29T12:00:00Z");
    await run({ ...deps, flows: async () => [flowOf({ alignment: "with" })] });
    expect((await store.listAlerts({ kind: "narrative", limit: 10 })).map((a) => a.line.text)).toEqual([
      "Privacy: 6h long build (z 2.9) with the 7d move · your view: fade · contrast favours continuation (medium confidence, conflicts with your view)",
      "Privacy: 6h long build (z 2.9) against the 7d move · your view: continuation · contrast favours continuation (medium confidence, agrees with your view)",
    ]);
  });

  test("views are read first: with no continuation or fade lean no flow is loaded", async () => {
    const { deps, store } = setup({ provider: new Provider() });
    deps.flows = () => Promise.reject(new Error("should not load"));
    expect(await run(deps)).toEqual({ ran: 0, statuses: { done: 0, failed: 0 }, stopped: "none", errors: [] });
    await store.setSetting(VIEWS_SETTING, { privacy: view("unsure") });
    expect((await run(deps)).errors).toEqual([]);
    await store.setSetting(VIEWS_SETTING, { privacy: view("fade") });
    expect((await run(deps)).errors).toEqual(["should not load"]);
  });

  test("INTEL_NARRATIVE_AUTO_DAILY (default 2) per UTC day; the counter resets the next day", async () => {
    const provider = new Provider();
    const flows = ["a", "b", "c"].map((id) => flowOf({ id, alignment: "against" }));
    const { deps, store, clock } = setup({ provider, flows });
    await store.setSetting(VIEWS_SETTING, Object.fromEntries(flows.map((f) => [f.id, view("continuation")])));
    expect(await run(deps)).toMatchObject({ ran: 2, stopped: "limit" });
    expect(await run(deps)).toMatchObject({ ran: 0, stopped: "limit" });
    expect(provider.prompts).toHaveLength(2);
    clock.now = new Date("2026-10-28T01:00:00Z");
    expect(await run({ ...deps, env: { INTEL_NARRATIVE_AUTO_DAILY: "1" } })).toMatchObject({ ran: 1, stopped: "limit" });
    expect(provider.prompts).toHaveLength(3);
  });

  test("budget gate: a run starts only with more than the deadline plus the margin left", async () => {
    const provider = new Provider();
    const { deps, store } = setup({ provider, flows: [AGAINST] });
    await store.setSetting(VIEWS_SETTING, { privacy: view("continuation") });
    expect(await run(deps, () => ENOUGH)).toMatchObject({ ran: 0, stopped: "budget" });
    expect(provider.prompts).toEqual([]);
    expect(await run(deps, () => ENOUGH + 1)).toMatchObject({ ran: 1 });
  });

  test("a capped result stops the stage and counts nothing", async () => {
    const provider = new Provider();
    const { deps, store } = setup({ provider, flows: [AGAINST], dailyCap: 0 });
    await store.setSetting(VIEWS_SETTING, { privacy: view("continuation") });
    expect(await run(deps)).toEqual({ ran: 0, statuses: { done: 0, failed: 0 }, stopped: "cap", errors: [] });
    expect(await store.getSetting(AUTO_SETTING)).toBeNull();
    expect(provider.prompts).toEqual([]);
  });

  test("no hosted web search: nothing runs and nothing is counted", async () => {
    const { deps, store } = setup({ provider: new Provider(false), flows: [AGAINST] });
    await store.setSetting(VIEWS_SETTING, { privacy: view("continuation") });
    expect(await run(deps)).toMatchObject({ ran: 0, stopped: "no_web_search" });
    expect(await store.getSetting(AUTO_SETTING)).toBeNull();
    expect(await store.listAlerts({ kind: "narrative", limit: 10 })).toEqual([]);
  });

  test("no candidate without a crossed view; a failed flow load is an error, not a throw", async () => {
    const provider = new Provider();
    const { deps, store } = setup({ provider, flows: [AGAINST] });
    expect(await run(deps)).toMatchObject({ ran: 0, stopped: "none" });
    await store.setSetting(VIEWS_SETTING, { privacy: view("fade") }); // fade against the move: nothing to test
    expect(await run(deps)).toMatchObject({ ran: 0 });
    expect(provider.prompts).toEqual([]);
    deps.flows = () => Promise.reject(new Error("snapshots unavailable"));
    expect(await run(deps)).toEqual({ ran: 0, statuses: { done: 0, failed: 0 }, stopped: "none", errors: ["snapshots unavailable"] });
  });
});
