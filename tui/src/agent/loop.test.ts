import { describe, expect, test } from "bun:test";
import { Agent, createAgent, summarizeInput, trimHistory, type AgentEvents } from "./loop.js";
import { makeDeps, ScriptedLLM, type ScriptStep } from "./testkit.js";
import { NOT_SENT } from "./tools.js";

function recorder() {
  const log: string[] = [];
  const ev: AgentEvents = {
    onText: (d) => log.push(`text:${d}`),
    onToolStart: (n, s) => log.push(`start:${n}:${s}`),
    onToolEnd: (n, ok, s) => log.push(`end:${n}:${ok ? "ok" : "err"}:${s}`),
  };
  return { log, ev };
}

async function setup(script: ScriptStep[], o: { maxRounds?: number; timeoutMs?: number } = {}) {
  const llm = new ScriptedLLM(script);
  const k = await makeDeps();
  const agent = new Agent({ provider: llm, deps: k.deps, now: () => new Date("2026-10-18T12:00:00Z"), ...o });
  return { llm, agent, ...k, ...recorder() };
}

describe("Agent", () => {
  test("text-only answer streams, returns, and builds the prompt", async () => {
    const { llm, agent, ev, log } = await setup([{ text: "BTC looks range-bound." }]);
    const r = await agent.ask("how is BTC?", ev);
    expect(r).toEqual({ text: "BTC looks range-bound.", stop: "end" });
    expect(log).toEqual(["text:BTC looks range-bound."]);
    expect(llm.questions[0]).toBe("[current time 2026-10-18T12:00:00.000Z]\nhow is BTC?");
    expect(llm.systems[0]).toContain("2026-10-18T12:00:00.000Z");
    expect(llm.systems[0]).toContain("testnet");
    expect(llm.systems[0]).toContain("NOT sent");
    expect(llm.toolSets[0]!.map((t) => t.name)).toContain("draft_order");
  });

  test("a tool round runs the tool, feeds the result back, then answers", async () => {
    const { llm, agent, ev, log } = await setup([
      { text: "Checking.", calls: [{ name: "get_book", input: { coin: "BTC" } }] },
      { text: "Spread is tight." },
    ]);
    const r = await agent.ask("book?", ev);
    expect(r.stop).toBe("end");
    expect(r.text).toBe("Checking.\n\nSpread is tight.");
    expect(log[0]).toBe("text:Checking.");
    expect(log[1]).toBe("start:get_book:BTC");
    expect(log[2]).toMatch(/^end:get_book:ok:\d+ chars$/);
    expect(llm.results).toHaveLength(1);
    expect(llm.results[0]![0]).toMatchObject({ id: "call_1", name: "get_book", isError: false });
    expect(JSON.parse(llm.results[0]![0]!.content).coin).toBe("BTC");
    expect(llm.finals).toEqual([false, false]);
  });

  test("tool calls in one round run sequentially in order", async () => {
    const { agent, ev, log } = await setup([
      { calls: [{ name: "get_alerts", input: {} }, { name: "get_positions", input: {} }] },
      { text: "ok" },
    ]);
    await agent.ask("x", ev);
    expect(log.filter((l) => /^(start|end):/.test(l)).map((l) => l.split(":").slice(0, 2).join(":"))).toEqual([
      "start:get_alerts", "end:get_alerts", "start:get_positions", "end:get_positions",
    ]);
  });

  test("draft_order calls the host exactly once and the result says NOT sent", async () => {
    const { llm, agent, ev, drafts } = await setup([
      { calls: [{ name: "draft_order", input: { coin: "BTC", side: "long", stop: { type: "pct", pct: 2 }, size: { usd: 500 } } }] },
      { text: "Drafted a ticket; it is waiting for your confirmation." },
    ]);
    const r = await agent.ask("long BTC 500 usd stop 2%", ev);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.kind).toBe("open");
    const res = llm.results[0]![0]!;
    expect(res.isError).toBe(false);
    expect(res.content).toContain(NOT_SENT);
    expect(res.content).toContain("It has NOT been sent");
    expect(r.text).toContain("waiting for your confirmation");
  });

  test("bad tool input and unknown tools come back as error results", async () => {
    const { llm, agent, ev, drafts, log } = await setup([
      { calls: [{ name: "draft_order", input: { coin: "BTC", side: "long", stop: { type: "pct", pct: 2 } } }, { name: "nope", input: {} }, { name: "get_book", input: { coin: "BTCC" } }] },
      { text: "I need a size." },
    ]);
    const r = await agent.ask("long btc", ev);
    expect(r.text).toBe("I need a size.");
    expect(drafts).toHaveLength(0);
    const [a, b, c] = llm.results[0]!;
    expect(a).toMatchObject({ isError: true });
    expect(a!.content).toContain("size");
    expect(b).toMatchObject({ isError: true, content: "unknown tool nope" });
    expect(c!.content).toContain("close matches");
    expect(log.filter((l) => l.startsWith("end:")).every((l) => l.includes(":err:"))).toBe(true);
  });

  test("past maxRounds the next step is forced final and its text is the answer", async () => {
    const call = { calls: [{ name: "get_alerts", input: {} }] };
    const { llm, agent, ev } = await setup([call, call, { text: "Final answer without tools." }], { maxRounds: 2 });
    const r = await agent.ask("loop", ev);
    expect(llm.finals).toEqual([false, false, true]);
    expect(llm.results).toHaveLength(2);
    expect(r).toEqual({ text: "Final answer without tools.", stop: "end" });
  });

  test("a final step that still asks for tools stops as max_rounds", async () => {
    const call = { text: "partial", calls: [{ name: "get_alerts", input: {} }] };
    const { llm, agent, ev } = await setup([call, call], { maxRounds: 1 });
    const r = await agent.ask("loop", ev);
    expect(llm.finals).toEqual([false, true]);
    expect(r.stop).toBe("max_rounds");
    expect(llm.results).toHaveLength(1);
  });

  test("provider stops (refusal, max_tokens, pause) are mirrored", async () => {
    const a = await setup([{ text: "no", stop: "refusal" }]);
    expect((await a.agent.ask("q", a.ev)).stop).toBe("refusal");
    const b = await setup([{ stop: "pause" }, { text: "continued" }]);
    expect(await b.agent.ask("q", b.ev)).toEqual({ text: "continued", stop: "end" });
  });

  test("a pause on the final round reports max_rounds", async () => {
    const { agent, ev } = await setup([{ calls: [{ name: "get_alerts", input: {} }] }, { stop: "pause" }], { maxRounds: 1 });
    expect((await agent.ask("q", ev)).stop).toBe("max_rounds");
  });

  test("history sent to the provider is capped, oldest pairs first", async () => {
    const { llm, agent, ev } = await setup([{ text: "a" }]);
    for (let i = 0; i < 15; i++) agent.history.push({ role: "user", content: `q${i}` }, { role: "assistant", content: `a${i}` });
    await agent.ask("now", ev);
    const sent = llm.histories[0]!;
    expect(sent).toHaveLength(20);
    expect(sent[0]).toEqual({ role: "user", content: "q5" });
    expect(sent.at(-1)).toEqual({ role: "assistant", content: "a14" });
    expect(agent.history).toHaveLength(32); // stored history is not truncated
    const big = (c: string) => "x".repeat(c === "u" ? 40_000 : 30_000);
    const t = trimHistory([
      { role: "user", content: big("u") }, { role: "assistant", content: big("a") },
      { role: "user", content: "q" }, { role: "assistant", content: "a" },
    ]);
    expect(t).toEqual([{ role: "user", content: "q" }, { role: "assistant", content: "a" }]);
  });

  test("caller abort ends the turn, keeps partial text, no throw", async () => {
    const { agent, ev, log } = await setup([{ text: "first part", calls: [{ name: "get_alerts", input: {} }] }, { hang: true }]);
    const ctrl = new AbortController();
    const p = agent.ask("slow", { ...ev, onToolEnd: (n, ok, s) => { ev.onToolEnd(n, ok, s); ctrl.abort(); } }, ctrl.signal);
    const r = await p;
    expect(r).toEqual({ text: "first part", stop: "aborted" });
    expect(log).toContain("text:first part");
    expect(agent.history).toEqual([{ role: "user", content: "slow" }, { role: "assistant", content: "first part" }]);
  });

  test("abort between the step and its tools runs no tools", async () => {
    const llm = new ScriptedLLM([{ calls: [{ name: "get_alerts", input: {} }] }]);
    const { deps } = await makeDeps();
    const agent = new Agent({ provider: llm, deps });
    const ctrl = new AbortController();
    const start = llm.start.bind(llm);
    llm.start = (s, h, q) => {
      const c = start(s, h, q);
      return { addToolResults: (r) => c.addToolResults(r), step: async (...args) => { const res = await c.step(...args); ctrl.abort(); return res; } };
    };
    const { ev, log } = recorder();
    const r = await agent.ask("x", ev, ctrl.signal);
    expect(r.stop).toBe("aborted");
    expect(llm.results).toHaveLength(0);
    expect(log.some((l) => l.startsWith("start:"))).toBe(false);
  });

  test("timeout aborts a hung step", async () => {
    const { agent, ev } = await setup([{ hang: true }], { timeoutMs: 25 });
    const r = await agent.ask("hang", ev);
    expect(r.stop).toBe("timeout");
    expect(agent.history.at(-1)).toEqual({ role: "assistant", content: "[timeout]" });
  });

  test("provider errors throw a keyless message and leave history alone", async () => {
    const llm = new ScriptedLLM([]);
    llm.start = () => ({
      step: async () => { throw Object.assign(new Error("Unauthorized sk-ant-SECRET"), { status: 401 }); },
      addToolResults() {},
    });
    const k = await makeDeps();
    const agent = new Agent({ provider: llm, deps: k.deps });
    const err = await agent.ask("q", recorder().ev).catch((e: Error) => e);
    expect((err as Error).message).toBe("agent provider rejected the credentials");
    expect(agent.history).toEqual([]);
    llm.start = () => ({ step: async () => { throw new Error("boom sk-ant-SECRET"); }, addToolResults() {} });
    const err2 = (await agent.ask("q", recorder().ev).catch((e: Error) => e)) as Error;
    expect(err2.message).toStartWith("agent provider error: boom");
  });

  test("history is kept across asks, passed to the provider, and cleared", async () => {
    const { llm, agent, ev } = await setup([{ text: "one" }]);
    await agent.ask("first", ev);
    expect(agent.history).toEqual([{ role: "user", content: "first" }, { role: "assistant", content: "one" }]);
    await agent.ask("second", ev);
    expect(llm.histories[1]).toEqual([{ role: "user", content: "first" }, { role: "assistant", content: "one" }]);
    expect(agent.history).toHaveLength(4);
    agent.clear();
    expect(agent.history).toEqual([]);
    await agent.ask("third", ev);
    expect(llm.histories[2]).toEqual([]);
  });
});

describe("summarizeInput / createAgent", () => {
  test("one-field input shows the value, several show k=v", () => {
    expect(summarizeInput({ coin: "BTC" })).toBe("BTC");
    expect(summarizeInput({ coin: "BTC", interval: "1h" })).toBe("coin=BTC interval=1h");
    expect(summarizeInput({})).toBe("");
    expect(summarizeInput({ stop: { type: "pct", pct: 2 }, size: { usd: 5 } })).toBe('stop={"type":"pct","pct":2} size={"usd":5}');
  });

  test("no provider env -> agent off with a reason; a key -> labelled agent", async () => {
    const { deps } = await makeDeps();
    const off = createAgent({}, deps);
    expect(off.agent).toBeNull();
    expect(off.label).toBe("agent off");
    expect(off.reason).toBe("no LLM configured: set ANTHROPIC_API_KEY or ANALYST_PROVIDER");
    const on = createAgent({ ANTHROPIC_API_KEY: "sk-ant-test", DESK_ANALYST_MODEL: "claude-test-1" }, deps);
    expect(on.agent).toBeInstanceOf(Agent);
    expect(on.label).toBe("claude-test-1");
  });
});
