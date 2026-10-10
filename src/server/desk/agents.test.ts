import { describe, expect, test } from "bun:test";
import { ANTHROPIC_SCOUT_MODEL, deskProviderFactory, estimateCost, MAX_SPAWNS_PER_RUN, runDesk } from "./agents.js";
import { DEFAULT_MODEL } from "../llm/provider.js";
import { makeService, ScriptedProvider, type ScriptStep } from "./testkit.js";
import type { DeskEvent } from "./types.js";

const trade = {
  coin: "ETH",
  side: "long",
  setup: "spot-led breakout retest",
  thesis: "Flows specialist reads a spot-led rally; macro reads liquidity expanding.",
  horizon: "swing",
  confidence: "medium",
  stop: 3800,
  target: 4500,
  riskPct: 0.5,
  invalidation: "daily close under 3850",
  evidence: [
    { source: "flows", point: "spot_led_rally, trap 18" },
    { source: "macro", point: "net liquidity +3% over 4w" },
  ],
};

function team(pm: ScriptStep[]) {
  return new ScriptedProvider("claude-opus-5-5", (system) => {
    if (system.includes("portfolio manager (PM) of a crypto desk")) return pm;
    if (system.includes("Derivatives & flows analyst")) return [{ calls: [{ name: "market_breadth", input: {} }] }, { text: "**Read:** spot-led, medium." }];
    if (system.includes("Macro, liquidity & fiscal")) return [{ text: "**Read:** liquidity expanding, medium." }];
    if (system.includes('"eth-unlocks"')) return [{ text: "**Read:** no unlocks this week." }];
    return [{ text: "ok" }];
  });
}

describe("runDesk", () => {
  test("the PM consults specialists in parallel, proposes through the governor, and the run is recorded", async () => {
    const { service, store } = makeService();
    const provider = team([
      {
        text: "Consulting the team.",
        calls: [
          {
            name: "consult_specialists",
            input: {
              tasks: [
                { specialist: "flows", task: "Decompose ETH's 72h move: OI, funding, premium." },
                { specialist: "macro", task: "Does liquidity support risk this month?" },
              ],
            },
          },
        ],
      },
      { calls: [{ name: "propose_trade", input: trade }] },
      { text: "**Verdict:** genuine spot-led flow, medium confidence. Opened a long." },
    ]);
    const events: DeskEvent[] = [];
    const res = await runDesk({ service, kind: "cycle", input: "ETH +6% in 4h", act: true, makeProvider: () => provider }, (e) => events.push(e));

    expect(res.answer).toContain("**Verdict:**");
    expect(res.stop).toBe("end");
    const starts = events.filter((e) => e.type === "agent_start").map((e) => (e as { agent: string }).agent);
    expect(starts).toEqual(["pm", "flows", "macro"]);
    // The flows specialist used its own tool.
    expect(events.some((e) => e.type === "tool_call" && e.agent === "flows" && e.name === "market_breadth")).toBe(true);
    // Reports came back to the PM as one tool result.
    const consult = provider.results.find((r) => r[0]?.name === "consult_specialists")![0]!;
    expect(JSON.parse(consult.content).reports.map((r: { id: string }) => r.id)).toEqual(["flows", "macro"]);
    // The proposal went through the governor and filled on paper.
    const proposal = events.find((e) => e.type === "proposal") as Extract<DeskEvent, { type: "proposal" }>;
    expect(proposal.status).toBe("executed");
    expect(await store.paperPositions()).toHaveLength(1);

    const run = await store.getRun(res.runId);
    expect(run!.status).toBe("done");
    expect(run!.answer).toContain("Verdict");
    expect(run!.events.some((e) => e.type === "agent_done" && e.agent === "macro")).toBe(true);
    expect(run!.events.some((e) => e.type === "text")).toBe(false); // deltas are not persisted
    // 3 agents × their steps at 1000 in / 100 out on Opus 5.5 pricing
    const done = events.at(-1) as Extract<DeskEvent, { type: "done" }>;
    expect(done.type).toBe("done");
    expect(done.costUsd).toBeGreaterThan(0);
  });

  test("analysis mode has no action tools: a propose_trade call fails as unknown", async () => {
    const { service, store } = makeService();
    const provider = team([{ calls: [{ name: "propose_trade", input: trade }] }, { text: "**Verdict:** analysis only." }]);
    await runDesk({ service, kind: "ask", input: "Is this a bull trap?", act: false, makeProvider: () => provider }, () => {});
    const r = provider.results[0]![0]!;
    expect(r.isError).toBe(true);
    expect(r.content).toContain("unknown tool propose_trade");
    expect(await store.listProposals({ limit: 10 })).toHaveLength(0);
    expect(provider.systems[0]).toContain("analysis mode");
  });

  test("spawn_agent runs an ad-hoc analyst with read tools only and enforces the spawn budget", async () => {
    const { service } = makeService();
    const spawn = (name: string, tools: string[]) => ({ name: "spawn_agent", input: { name, mandate: "Token unlock and supply calendar for ETH", task: "Any unlocks this week?", tools } });
    const provider = team([
      { calls: [spawn("eth-unlocks", ["get_hl_markets"]), spawn("bad", ["propose_trade"])] },
      { calls: Array.from({ length: MAX_SPAWNS_PER_RUN + 1 }, (_, i) => spawn(`s${i}`, [])) },
      { text: "**Verdict:** done." },
    ]);
    const events: DeskEvent[] = [];
    await runDesk({ service, kind: "ask", input: "unlocks?", act: false, makeProvider: () => provider }, (e) => events.push(e));
    const [first, second] = provider.results;
    expect(JSON.parse(first![0]!.content).report).toContain("no unlocks");
    expect(first![1]!.content).toContain("not read tools: propose_trade");
    const budgetErrors = second!.filter((r) => r.content.includes("spawn budget spent"));
    expect(budgetErrors.length).toBe(2); // one used above, so only 2 of 4 fit
  });

  test("a provider failure ends the agent, and the run still finishes", async () => {
    const { service, store } = makeService();
    const provider = {
      id: "anthropic" as const,
      model: "claude-opus-5-5",
      webSearch: false,
      start: () => ({
        step: async () => {
          throw Object.assign(new Error("boom"), { status: 429 });
        },
        addToolResults: () => {},
      }),
    };
    const events: DeskEvent[] = [];
    const res = await runDesk({ service, kind: "ask", input: "q", act: false, makeProvider: () => provider }, (e) => events.push(e));
    expect(res.stop).toBe("error");
    expect(events.some((e) => e.type === "error" && e.error.includes("rate limiting"))).toBe(true);
    expect((await store.getRun(res.runId))!.status).toBe("error");
  });

  /** A provider whose step() never resolves on its own, only when the signal it's given aborts. */
  function hangingProvider(model: string) {
    return {
      id: "anthropic" as const,
      model,
      webSearch: false,
      start: () => ({
        step: (_specs: unknown, _hooks: unknown, opts: { signal: AbortSignal }) =>
          new Promise<never>((_, reject) => opts.signal.addEventListener("abort", () => reject(new Error("aborted")))),
        addToolResults: () => {},
      }),
    };
  }

  test("a scout that never finishes is cut off at its own deadline; the PM still gets a timeout report and decides", async () => {
    const pmProvider = new ScriptedProvider("claude-opus-5-5", (system) => {
      if (system.includes("portfolio manager (PM) of a crypto desk")) {
        return [
          { calls: [{ name: "consult_specialists", input: { tasks: [{ specialist: "flows", task: "Why did ETH move 6% in the last 4 hours?" }] } }] },
          { text: "**Verdict:** decided despite the timeout." },
        ];
      }
      return [{ text: "ok" }];
    });
    const { service } = makeService();
    const res = await runDesk(
      { service, kind: "ask", input: "why did ETH move?", act: false, timeoutMs: 200, pmReserveMs: 150, makeProvider: (role) => (role === "pm" ? pmProvider : hangingProvider("flows-scout")) },
      () => {},
    );
    expect(res.stop).toBe("end");
    expect(res.answer).toContain("decided despite the timeout");
    const consult = pmProvider.results.find((r) => r[0]?.name === "consult_specialists")![0]!;
    const reports = JSON.parse(consult.content).reports;
    expect(reports).toHaveLength(1);
    expect(reports[0].stop).toBe("timeout");
    expect(reports[0].report).toMatch(/^Timed out after \d+s\.$/);
  });

  test("a PM that runs out of time stores the run as timeout, not done", async () => {
    const { service, store } = makeService();
    const res = await runDesk({ service, kind: "ask", input: "q", act: false, timeoutMs: 30, makeProvider: () => hangingProvider("hanging-pm") }, () => {});
    expect(res.stop).toBe("timeout");
    expect((await store.getRun(res.runId))!.status).toBe("timeout");
  });
});

describe("deskProviderFactory", () => {
  test("an Anthropic key puts the PM on Claude Opus 5.5 at high effort and scouts on Sonnet 5.5 at medium, whatever ANALYST_PROVIDER says", () => {
    const factory = deskProviderFactory({ ANTHROPIC_API_KEY: "k", ANALYST_PROVIDER: "openrouter", OPENROUTER_API_KEY: "ork", DESK_ANALYST_MODEL: "x/y" });
    const pm = factory("pm")!;
    const scout = factory("specialist")!;
    expect([pm.id, pm.model, pm.effort]).toEqual(["anthropic", DEFAULT_MODEL, "high"]);
    expect([scout.id, scout.model, scout.effort]).toEqual(["anthropic", ANTHROPIC_SCOUT_MODEL, "medium"]);
  });

  test("Anthropic-first beats DESK_SCOUT_PROVIDER, and keeps Claude models named in DESK_ANALYST_MODEL / DESK_SCOUT_MODEL", () => {
    const factory = deskProviderFactory({
      ANALYST_ANTHROPIC_API_KEY: "k",
      OPENROUTER_API_KEY: "ork",
      DESK_SCOUT_PROVIDER: "openrouter",
      DESK_ANALYST_MODEL: "claude-fable-5-1",
      DESK_SCOUT_MODEL: "claude-haiku-4-5",
    });
    expect(factory("pm")!.model).toBe("claude-fable-5-1");
    expect([factory("specialist")!.id, factory("specialist")!.model]).toEqual(["anthropic", "claude-haiku-4-5"]);
  });

  test("with no Anthropic key the desk falls through to the configured provider", () => {
    const factory = deskProviderFactory({ OPENROUTER_API_KEY: "ork", ANALYST_PROVIDER: "openrouter", DESK_ANALYST_MODEL: "x/y" });
    expect([factory("pm")!.id, factory("pm")!.model]).toEqual(["openrouter", "x/y"]);
    expect(factory("specialist")!.id).toBe("openrouter");
  });

  test("DESK_ANTHROPIC_FIRST=false restores the analyst's provider order", () => {
    const factory = deskProviderFactory({ ANTHROPIC_API_KEY: "k", ANALYST_PROVIDER: "openrouter", OPENROUTER_API_KEY: "ork", DESK_ANALYST_MODEL: "x/y", DESK_ANTHROPIC_FIRST: "false" });
    expect(factory("pm")!.id).toBe("openrouter");
  });

  test("PM always runs the analyst's provider at high effort; scouts default to medium on the same provider", () => {
    const factory = deskProviderFactory({ DESK_ANTHROPIC_FIRST: "false", ANALYST_API_KEY: "k", DESK_ANALYST_MODEL: "claude-fable-5-1" });
    const pm = factory("pm")!;
    const scout = factory("specialist")!;
    expect(pm.model).toBe("claude-fable-5-1");
    expect(pm.effort).toBe("high");
    expect(scout.model).toBe("claude-fable-5-1");
    expect(scout.effort).toBe("medium");
  });

  test("DESK_SCOUT_MODEL overrides only the scout's model, same provider", () => {
    const factory = deskProviderFactory({ DESK_ANTHROPIC_FIRST: "false", ANALYST_API_KEY: "k", DESK_SCOUT_MODEL: "claude-sonnet-5-5" });
    expect(factory("pm")!.model).toBe(DEFAULT_MODEL);
    const scout = factory("specialist")!;
    expect(scout.id).toBe("anthropic");
    expect(scout.model).toBe("claude-sonnet-5-5");
  });

  test("DESK_SCOUT_PROVIDER moves scouts to a different provider; the PM stays on the analyst's", () => {
    const factory = deskProviderFactory({ DESK_ANTHROPIC_FIRST: "false", ANALYST_API_KEY: "k", OPENROUTER_API_KEY: "ork", DESK_SCOUT_PROVIDER: "openrouter", DESK_SCOUT_MODEL: "x/y:online" });
    expect(factory("pm")!.id).toBe("anthropic");
    const scout = factory("specialist")!;
    expect(scout.id).toBe("openrouter");
    expect(scout.model).toBe("x/y:online");
  });

  test("DESK_SCOUT_PROVIDER with no key falls back to the analyst's provider and warns once", () => {
    const warnings: unknown[][] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => void warnings.push(a);
    try {
      const factory = deskProviderFactory({ DESK_ANTHROPIC_FIRST: "false", ANALYST_API_KEY: "k", DESK_SCOUT_PROVIDER: "openrouter" }); // no OPENROUTER_API_KEY
      expect(factory("specialist")!.id).toBe("anthropic");
      expect(factory("specialist")!.id).toBe("anthropic");
      expect(warnings.length).toBe(1);
      expect(String(warnings[0]![0])).toContain("DESK_SCOUT_PROVIDER=openrouter");
    } finally {
      console.warn = orig;
    }
  });

  test("DESK_SCOUT_PROVIDER with no resolvable model falls back and warns", () => {
    const warnings: unknown[][] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => void warnings.push(a);
    try {
      // openrouter's curated list is empty by default; no DESK_SCOUT_MODEL/ANALYST_OPENROUTER_MODELS leaves no model to resolve.
      const factory = deskProviderFactory({ DESK_ANTHROPIC_FIRST: "false", ANALYST_API_KEY: "k", OPENROUTER_API_KEY: "ork", DESK_SCOUT_PROVIDER: "openrouter" });
      expect(factory("specialist")!.id).toBe("anthropic");
      expect(warnings.length).toBe(1);
    } finally {
      console.warn = orig;
    }
  });

  test("an unknown DESK_SCOUT_PROVIDER falls back and warns", () => {
    const warnings: unknown[][] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => void warnings.push(a);
    try {
      const factory = deskProviderFactory({ DESK_ANTHROPIC_FIRST: "false", ANALYST_API_KEY: "k", DESK_SCOUT_PROVIDER: "not-a-real-provider", DESK_SCOUT_MODEL: "m" });
      expect(factory("specialist")!.id).toBe("anthropic");
      expect(warnings.length).toBe(1);
    } finally {
      console.warn = orig;
    }
  });
});

test("estimateCost prices known models and gives up on unknown ones", () => {
  expect(estimateCost(new Map([["claude-opus-5-5", { input_tokens: 1_000_000, output_tokens: 100_000 }]]))).toBe(6);
  expect(estimateCost(new Map([["mystery", { input_tokens: 1, output_tokens: 1 }]]))).toBeNull();
});
