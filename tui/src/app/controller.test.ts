import { beforeEach, describe, expect, test } from "bun:test";
import { demoAccountAddress, DemoInfo } from "../core/demo.js";
import type { Exchange } from "../core/exchange.js";
import type { Alert, AppState, Config, MarketRow, SendResult, Ticket } from "../core/types.js";
import { testConfig } from "../agent/testkit.js";
import { agentOutcomeNote, closestCoins, Controller, sortMarkets, type AgentEventsLike, type AgentLike, type StoreLike, type Timers } from "./controller.js";
import type { Entry } from "./model.js";

const NOW = 1_792_329_069_607;

class FakeStore implements StoreLike {
  listeners = new Set<() => void>();
  alertFns = new Set<(a: Alert) => void>();
  refreshes = 0;
  constructor(public state: AppState) {}
  getState = () => this.state;
  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  onAlert(fn: (a: Alert) => void) {
    this.alertFns.add(fn);
    return () => this.alertFns.delete(fn);
  }
  oiSeries() {
    return [];
  }
  async refreshAccount() {
    this.refreshes++;
  }
  patch(p: Partial<AppState>) {
    this.state = { ...this.state, ...p };
    for (const f of this.listeners) f();
  }
  alert(a: Alert) {
    for (const f of this.alertFns) f(a);
  }
}

class FakeTimers implements Timers {
  timeouts = new Map<number, () => void>();
  intervals = new Map<number, () => void>();
  private n = 0;
  setTimeout(fn: () => void) {
    this.timeouts.set(++this.n, fn);
    return this.n;
  }
  clearTimeout(h: unknown) {
    this.timeouts.delete(h as number);
  }
  setInterval(fn: () => void) {
    this.intervals.set(++this.n, fn);
    return this.n;
  }
  clearInterval(h: unknown) {
    this.intervals.delete(h as number);
  }
  fireTimeouts() {
    const fns = [...this.timeouts.values()];
    this.timeouts.clear();
    for (const f of fns) f();
  }
}

class FakeExchange implements Exchange {
  sent: Ticket[] = [];
  constructor(private result: SendResult = { ok: true, lines: ["filled 0.0123 BTC @ 81,940.0"], errors: [], oids: [91234] }) {}
  async send(t: Ticket): Promise<SendResult> {
    this.sent.push(t);
    return this.result;
  }
}

type AskFn = (q: string, ev: AgentEventsLike, signal?: AbortSignal) => Promise<{ text: string; stop: string }>;
class FakeAgent implements AgentLike {
  questions: string[] = [];
  cleared = 0;
  constructor(public impl: AskFn) {}
  ask(q: string, ev: AgentEventsLike, signal?: AbortSignal) {
    this.questions.push(q);
    return this.impl(q, ev, signal);
  }
  clear() {
    this.cleared++;
  }
}

const info = new DemoInfo(() => NOW);
let markets: MarketRow[];
let baseState: AppState;

beforeEach(async () => {
  markets = await info.markets();
  const account = await info.account(demoAccountAddress, markets);
  baseState = { config: testConfig(), markets, marketsAt: NOW, marketsError: null, account, accountError: null, alerts: [], ws: "off" };
});

const tradeCfg = (over: Partial<Config> = {}): Config =>
  testConfig({
    demo: false,
    canTrade: true,
    maxNotionalUsd: 1_000_000,
    limits: { maxRiskPct: 1, maxOpenRiskPct: 100, maxGrossLeverage: 10, maxCoinLeverage: 5, maxPositions: 10, minRewardRisk: 1 },
    ...over,
  });

function setup(o: { config?: Config; exchange?: Exchange | null; agent?: AgentLike | null; pulse?: () => Promise<never>; brief?: () => Promise<null> } = {}) {
  const config = o.config ?? testConfig();
  const store = new FakeStore({ ...baseState, config });
  const timers = new FakeTimers();
  let quits = 0;
  const ctl = new Controller({
    config,
    store,
    info,
    exchange: o.exchange ?? null,
    agent: o.agent ?? null,
    agentLabel: "scripted-1",
    ...(o.pulse ? { pulse: o.pulse } : {}),
    ...(o.brief ? { brief: o.brief } : {}),
    now: () => NOW,
    timers,
    batchMs: 0,
    ticketId: () => "t-1",
    onQuit: () => quits++,
  });
  const kinds = () => ctl.getView().entries.map((e) => e.kind);
  const last = <K extends Entry["kind"]>(kind: K) => [...ctl.getView().entries].reverse().find((e) => e.kind === kind) as Extract<Entry, { kind: K }> | undefined;
  return { ctl, store, timers, kinds, last, quits: () => quits };
}

const key = (k: Record<string, boolean>) => k;

describe("pure helpers", () => {
  test("sortMarkets sorts, reverses and filters", () => {
    const byOi = sortMarkets(markets, "oi", "desc", "");
    expect(byOi[0]!.coin).toBe("BTC");
    const asc = sortMarkets(markets, "oi", "asc", "");
    expect(asc[asc.length - 1]!.coin).toBe("BTC");
    const chg = sortMarkets(markets, "chg", "desc", "");
    expect(Math.abs(chg[0]!.dayChangePct)).toBeGreaterThanOrEqual(Math.abs(chg[1]!.dayChangePct));
    expect(sortMarkets(markets, "oi", "desc", "et").map((m) => m.coin)).toContain("ETH");
    expect(sortMarkets(markets, "oi", "desc", "zzzz")).toEqual([]);
  });

  test("closestCoins suggests prefixes and near misses", () => {
    expect(closestCoins(markets, "BT")).toContain("BTC");
    expect(closestCoins(markets, "ETG")).toContain("ETH");
    expect(closestCoins(markets, "QQQQQQQ")).toEqual([]);
  });
});

describe("controller", () => {
  test("starts with a banner in prompt mode", () => {
    const { ctl, kinds } = setup();
    expect(kinds()).toEqual(["banner"]);
    expect(ctl.getView().mode).toBe("prompt");
    expect(ctl.getView().agentLabel).toBeNull();
  });

  test("/pos appends the user line and a positions snapshot", async () => {
    const { ctl, kinds, last } = setup();
    await ctl.submit("/pos");
    expect(kinds()).toEqual(["banner", "user", "view-snapshot"]);
    const s = last("view-snapshot")!;
    expect(s.view).toBe("pos");
  });

  test("parse errors and unknown coins become error entries", async () => {
    const { ctl, last } = setup();
    await ctl.submit("/long BTC stop");
    expect(last("error")!.source).toBe("parse");
    await ctl.submit("/coin BTCC");
    const e = last("error")!;
    expect(e.message).toBe("unknown coin BTCC");
    expect(e.hint).toContain("BTC");
  });

  test("text with no agent is an error, not a crash", async () => {
    const { ctl, last } = setup();
    await ctl.submit("what is BTC doing");
    expect(last("error")!.message).toContain("agent unavailable");
    expect(ctl.getView().mode).toBe("prompt");
  });

  test("/markets overlay: select, sort, reverse, filter, Esc closes with nothing appended", async () => {
    const { ctl, kinds } = setup();
    await ctl.submit("/markets");
    expect(ctl.getView().mode).toBe("overlay");
    const n = kinds().length;
    await ctl.key("j", {});
    await ctl.key("", key({ downArrow: true }));
    expect(ctl.getView().overlay).toMatchObject({ kind: "markets", selected: 2 });
    await ctl.key("v", {});
    expect(ctl.getView().overlay).toMatchObject({ sort: "vol", dir: "desc", selected: 0 });
    await ctl.key("v", {});
    expect(ctl.getView().overlay).toMatchObject({ sort: "vol", dir: "asc" });
    await ctl.key("/", {});
    await ctl.key("e", {});
    await ctl.key("t", {});
    await ctl.key("", key({ return: true }));
    expect(ctl.getView().overlay).toMatchObject({ filter: "et", editing: null });
    await ctl.key("", key({ escape: true }));
    expect(ctl.getView().mode).toBe("prompt");
    expect(kinds().length).toBe(n);
  });

  test("markets Enter runs /coin for the selected row", async () => {
    const { ctl, last } = setup();
    await ctl.submit("/markets oi");
    await ctl.key("", key({ return: true }));
    expect(ctl.getView().overlay).toBeNull();
    expect(last("user")!.text).toBe("/coin BTC");
    const s = last("view-snapshot")!;
    expect(s.view).toBe("coin");
  });

  test("/book overlay loads, polls, and appends a summary on Esc; b from markets returns there", async () => {
    const { ctl, timers, last } = setup();
    await ctl.submit("/book btc");
    const o = ctl.getView().overlay;
    expect(o?.kind).toBe("book");
    expect(o?.kind === "book" && o.book?.coin).toBe("BTC");
    expect(timers.intervals.size).toBe(1);
    await ctl.key("+", {});
    await ctl.key("", key({ escape: true }));
    expect(timers.intervals.size).toBe(0);
    expect(last("view-snapshot")!.view).toBe("book-summary");
    expect(ctl.getView().mode).toBe("prompt");

    await ctl.submit("/markets");
    await ctl.key("b", {});
    expect(ctl.getView().overlay?.kind).toBe("book");
    await ctl.key("q", {});
    expect(ctl.getView().overlay?.kind).toBe("markets");
  });

  test("demo order: ticket pending, y simulates, nothing is sent", async () => {
    const ex = new FakeExchange();
    const { ctl, last, kinds } = setup({ exchange: ex });
    await ctl.submit("/long HYPE risk 0.5% stop 2% tp 2R");
    const v = ctl.getView();
    expect(v.mode).toBe("ticket");
    expect(v.pending!.ui.access).toBe("demo");
    expect(v.pending!.ticket.blockers).toEqual(["demo: orders disabled"]);
    expect(v.pending!.ticket.verdict!.approved).toBe(true);
    // typed keys are dropped
    await ctl.key("x", {});
    expect(ctl.getView().input).toBe("");
    await ctl.key("y", {});
    expect(ctl.getView().mode).toBe("prompt");
    expect(last("ticket")!.outcome).toBe("simulated");
    const r = last("result")!;
    expect(r.demo).toBe(true);
    expect(r.result.ok).toBe(true);
    expect(r.result.lines[0]).toBe("demo: simulated, nothing sent");
    expect(r.result.lines[1]).toStartWith("demo: would buy");
    expect(ex.sent).toEqual([]);
    expect(kinds().slice(-2)).toEqual(["ticket", "result"]);
  });

  test("demo: a ticket the governor refuses is simulated as refused", async () => {
    const { ctl, last } = setup();
    await ctl.submit("/long BTC risk 0.5% stop 2%");
    await ctl.key("y", {});
    const r = last("result")!;
    expect(r.result.ok).toBe(false);
    expect(r.result.errors.join(" ")).toContain("would be refused: already long BTC");
  });

  test("risk sizing works for atr / pdl stops via riskPct", async () => {
    const { ctl } = setup({ config: tradeCfg() });
    await ctl.submit("/long BTC risk 0.5% stop pdl");
    const t = ctl.getView().pending!.ticket;
    expect(t.stopPx).not.toBeNull();
    expect(t.notes.join(" ")).toContain("size = risk 0.5% of equity");
  });

  test("trade mode: y requotes, sends once, records the result and refreshes the account", async () => {
    const ex = new FakeExchange();
    const { ctl, store, last } = setup({ config: tradeCfg(), exchange: ex });
    await ctl.submit("/long HYPE $500 stop 2% tp 3%");
    const t = ctl.getView().pending!.ticket;
    expect(t.blockers).toEqual([]);
    expect(t.canSend).toBe(true);
    await ctl.key("y", {});
    expect(ex.sent.length).toBe(1);
    expect(ex.sent[0]!.id).toBe("t-1");
    expect(last("ticket")!.outcome).toBe("sent");
    expect(last("result")!.result.oids).toEqual([91234]);
    expect(store.refreshes).toBe(1);
    expect(ctl.getView().mode).toBe("prompt");
  });

  test("a changed requote needs another y", async () => {
    const ex = new FakeExchange();
    const { ctl, store } = setup({ config: tradeCfg(), exchange: ex });
    await ctl.submit("/long HYPE $500 stop 2%");
    const before = ctl.getView().pending!.ticket;
    store.patch({ markets: store.state.markets.map((m) => (m.coin === "HYPE" ? { ...m, markPx: m.markPx * 1.02, midPx: null } : m)) });
    await ctl.key("y", {});
    const p = ctl.getView().pending!;
    expect(ex.sent.length).toBe(0);
    expect(p.ui.changedWhy).toContain("mark moved");
    expect(p.ui.previous!.markPx).toBe(before.markPx);
    expect(p.ui.phase).toBe("awaiting");
    await ctl.key("y", {});
    expect(ex.sent.length).toBe(1);
  });

  test("failed send freezes as failed", async () => {
    const ex = new FakeExchange({ ok: false, lines: [], errors: ["insufficient margin"], oids: [] });
    const { ctl, last } = setup({ config: tradeCfg(), exchange: ex });
    await ctl.submit("/short HYPE $300 stop 2%");
    await ctl.key("y", {});
    expect(last("ticket")!.outcome).toBe("failed");
    expect(last("result")!.result.errors).toEqual(["insufficient margin"]);
  });

  test("n discards; a read-only ticket has no y and is dismissed", async () => {
    const ex = new FakeExchange();
    const a = setup({ config: tradeCfg(), exchange: ex });
    await a.ctl.submit("/long HYPE $500 stop 2%");
    await a.ctl.key("n", {});
    expect(a.last("ticket")!.outcome).toBe("discarded");

    const b = setup({ config: tradeCfg({ canTrade: false }), exchange: null });
    await b.ctl.submit("/long BTC $500 stop 2%");
    expect(b.ctl.getView().pending!.ui.access).toBe("read-only");
    await b.ctl.key("y", {});
    expect(b.ctl.getView().mode).toBe("ticket");
    await b.ctl.key("", key({ escape: true }));
    expect(b.last("ticket")!.outcome).toBe("dismissed");
    expect(ex.sent).toEqual([]);
  });

  test("close / cancel all / stop open tickets", async () => {
    const { ctl } = setup({ config: tradeCfg() });
    await ctl.submit("/close BTC 50");
    expect(ctl.getView().pending!.ticket.action.kind).toBe("close");
    await ctl.key("n", {});
    await ctl.submit("/cancel all BTC");
    const t = ctl.getView().pending!.ticket;
    expect(t.action.kind === "cancel" && t.action.oids.map((o) => o.oid)).toEqual([900000001, 900000002]);
    await ctl.key("n", {});
    await ctl.submit("/stop BTC 79000");
    const p = ctl.getView().pending!;
    expect(p.ticket.action.kind).toBe("stop");
    expect(p.ui.oldStopPx).toBeCloseTo(78287.7);
  });

  test("agent text streams, paragraphs flush to the transcript, tools become tool lines", async () => {
    const agent = new FakeAgent(async (_q, ev) => {
      ev.onText("First para");
      ev.onText("graph.\n\nSecond ");
      ev.onToolStart("get_coin", "BTC");
      ev.onToolEnd("get_coin", true, "120 chars");
      ev.onToolStart("get_book", "BTC");
      ev.onToolEnd("get_book", false, "book unavailable");
      ev.onText("After tools.");
      return { text: "", stop: "end" };
    });
    const { ctl, kinds, last } = setup({ agent });
    await ctl.submit("how is BTC");
    expect(kinds()).toEqual(["banner", "user", "agent-text", "agent-text", "tool-line", "tool-line", "agent-text"]);
    const e = ctl.getView().entries;
    expect(e[2]).toMatchObject({ text: "First paragraph." });
    expect(e[3]).toMatchObject({ text: "Second", cont: true });
    expect(e[5]).toMatchObject({ status: "error", error: "book unavailable" });
    expect(last("agent-text")).toMatchObject({ text: "After tools." });
    expect(last("agent-text")!.cont).toBeUndefined();
    expect(ctl.getView().mode).toBe("prompt");
  });

  test("Esc aborts the agent; a running tool is marked aborted", async () => {
    const agent = new FakeAgent(
      (_q, ev, signal) =>
        new Promise((resolve) => {
          ev.onText("partial");
          ev.onToolStart("get_candles", "BTC");
          signal!.addEventListener("abort", () => resolve({ text: "partial", stop: "aborted" }));
        }),
    );
    const { ctl, last } = setup({ agent });
    const done = ctl.submit("think hard");
    expect(ctl.getView().mode).toBe("agent");
    // Enter is ignored while running
    await ctl.key("x", {});
    await ctl.key("", key({ return: true }));
    expect(ctl.getView().input).toBe("x");
    await ctl.key("", key({ escape: true }));
    await done;
    expect(last("tool-line")!.status).toBe("aborted");
    expect(last("note")!.text).toBe("aborted");
    expect(last("agent-text")!.text).toBe("partial");
    expect(ctl.getView().mode).toBe("prompt");
  });

  test("agent provider failure keeps partial text and adds an error", async () => {
    const agent = new FakeAgent(async (_q, ev) => {
      ev.onText("half");
      throw new Error("agent provider error (HTTP 500)");
    });
    const { ctl, last } = setup({ agent });
    await ctl.submit("hi");
    expect(last("agent-text")!.text).toBe("half");
    expect(last("error")!.message).toContain("HTTP 500");
  });

  test("agent draftOrder shows a ticket at once; a second draft gets the pending one; the outcome reaches the next question", async () => {
    let first: Ticket | null = null;
    let second: Ticket | null = null;
    let ctlRef: Controller | null = null;
    const agent = new FakeAgent(async (q, ev) => {
      if (q.endsWith("draft it")) {
        ev.onToolStart("draft_order", "BTC long");
        first = await ctlRef!.draftOrder({ kind: "open", intent: { asset: "HYPE", side: "long", leverage: 3, size: { usd: 500 }, entry: { type: "market" }, stop: { type: "pct", pct: 2 } } });
        ev.onToolEnd("draft_order", true, "ok");
        second = await ctlRef!.draftOrder({ kind: "close", coin: "ETH", pct: 100 });
        ev.onText("Drafted below.");
      }
      return { text: "", stop: "end" };
    });
    const s = setup({ agent, config: tradeCfg() });
    ctlRef = s.ctl;
    await s.ctl.submit("draft it");
    expect(first!.id).toBe("t-1");
    expect(second!.id).toBe("t-1");
    expect(second!.warnings[0]).toContain("already pending");
    expect(s.ctl.getView().mode).toBe("ticket");
    expect(s.ctl.getView().pending!.ui.source).toBe("agent");
    await s.ctl.key("n", {});
    expect(s.ctl.getView().mode).toBe("prompt");
    await s.ctl.submit("ok next");
    expect(agent.questions[1]).toStartWith("[ticket t-1 HYPE long: discarded by the human, not sent]\nok next");
  });

  test("Ctrl-C arms for 2 s, a second press quits and discards a pending ticket", async () => {
    const { ctl, timers, quits, last } = setup();
    await ctl.key("c", key({ ctrl: true }));
    expect(ctl.getView().quitArmed).toBe(true);
    timers.fireTimeouts();
    expect(ctl.getView().quitArmed).toBe(false);
    await ctl.submit("/long BTC risk 0.5% stop 2%");
    await ctl.key("c", key({ ctrl: true }));
    await ctl.key("c", key({ ctrl: true }));
    expect(quits()).toBe(1);
    expect(last("ticket")!.outcome).toBe("discarded");
  });

  test("/quit quits at once", async () => {
    const { ctl, quits } = setup();
    await ctl.submit("/quit");
    expect(quits()).toBe(1);
  });

  test("prompt editing, history and completion", async () => {
    const { ctl } = setup();
    for (const ch of "/hlp") await ctl.key(ch, {});
    await ctl.key("", key({ leftArrow: true }));
    await ctl.key("", key({ leftArrow: true }));
    await ctl.key("e", {});
    expect(ctl.getView().input).toBe("/help");
    await ctl.key("", key({ return: true }));
    await ctl.submit("/alerts");
    await ctl.key("d", {});
    await ctl.key("", key({ upArrow: true }));
    expect(ctl.getView().input).toBe("/alerts");
    await ctl.key("", key({ upArrow: true }));
    expect(ctl.getView().input).toBe("/help");
    await ctl.key("", key({ downArrow: true }));
    await ctl.key("", key({ downArrow: true }));
    expect(ctl.getView().input).toBe("d");
    await ctl.key("u", key({ ctrl: true }));
    expect(ctl.getView().input).toBe("");

    for (const ch of "/bo") await ctl.key(ch, {});
    await ctl.key("", key({ tab: true }));
    expect(ctl.getView().input).toBe("/book ");
    await ctl.key("", key({ escape: true }));
    for (const ch of "/c") await ctl.key(ch, {});
    await ctl.key("", key({ tab: true }));
    const c = ctl.getView().completion!;
    expect(c.items.map((i) => i.label)).toContain("/coin");
    await ctl.key("", key({ tab: true }));
    const pick = c.items[1]!.label;
    await ctl.key("", key({ return: true }));
    expect(ctl.getView().input).toBe(`${pick} `);
    expect(ctl.getView().completion).toBeNull();
  });

  test("store alerts and account errors append entries once", () => {
    const { store, kinds, last } = setup();
    store.alert({ key: "k", level: "warn", title: "ETH no stop", detail: "short 3 ETH", at: NOW });
    expect(last("alert")!.alert.title).toBe("ETH no stop");
    store.patch({ accountError: "HTTP 500" });
    store.patch({ accountError: "HTTP 500" });
    expect(kinds().filter((k) => k === "error").length).toBe(1);
  });

  test("/pulse without lab, /brief empty and failing, /model, /clear, /help", async () => {
    const agent = new FakeAgent(async () => ({ text: "", stop: "end" }));
    const { ctl, last } = setup({ agent });
    await ctl.submit("/pulse");
    expect(last("note")!.text).toContain("lab not configured");
    await ctl.submit("/brief");
    expect(last("note")!.text).toContain("no brief");
    await ctl.submit("/model");
    expect(last("view-snapshot")).toMatchObject({ view: "model", data: { label: "scripted-1" } });
    await ctl.submit("/clear");
    expect(agent.cleared).toBe(1);
    await ctl.submit("/help");
    expect(last("view-snapshot")!.view).toBe("help");

    const b = setup({ pulse: async () => Promise.reject(new Error("lab_market_pulse failed: x [HTTP 502]")), brief: async () => Promise.reject(new Error("bad json")) });
    await b.ctl.submit("/pulse");
    expect(b.last("error")).toMatchObject({ source: "pulse", message: "lab_market_pulse failed: x [HTTP 502]" });
    await b.ctl.submit("/brief");
    expect(b.last("error")).toMatchObject({ source: "brief" });
  });

  test("agentOutcomeNote includes send results", () => {
    const t = { id: "t-9", coin: "BTC", side: "long", action: { kind: "open" } } as unknown as Ticket;
    expect(agentOutcomeNote(t, "sent", { ok: true, lines: ["filled 0.01 BTC @ 61,200.0"], errors: [], oids: [1] })).toBe(
      "[ticket t-9 BTC long: confirmed by the human and sent; filled 0.01 BTC @ 61,200.0]",
    );
  });
});
