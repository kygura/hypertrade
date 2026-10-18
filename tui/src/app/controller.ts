// The TUI's state machine (DESIGN.md §6). Framework-free: Ink reads it through
// subscribe()/getView() (useSyncExternalStore) and feeds it keys and submits.
// Everything it talks to is injected. Nothing throws out of it: failures become
// `error` entries in the transcript. Nothing here ever sends an order without a
// human `y` on the pending ticket.
import { complete } from "../commands/complete.js";
import { orderToIntent } from "../commands/intent.js";
import { parseInput, type Command, type OrderCommand, type SortKey } from "../commands/parse.js";
import type { Brief } from "../core/brief.js";
import { buildCoinView, closestCoins } from "../core/coin.js";

export { closestCoins };
import type { Exchange } from "../core/exchange.js";
import type { Pulse } from "../core/lab.js";
import { buildTicket, findMarket, livePx, requote, type TicketDeps, type TicketRequest } from "../core/ticket.js";
import type { Alert, AppState, Config, InfoSource, MarketRow, SendResult, Ticket, TicketAction } from "../core/types.js";
import { fmtPx, fmtSz, fmtUsd } from "../ui/format.js";
import { bookLevels, bookMaxLevels, overlayHeight } from "./model.js";
import type {
  AgentRun,
  BookOverlay,
  Entry,
  HelpItem,
  KeyLike,
  MarketsOverlay,
  Mode,
  Overlay,
  PendingTicket,
  Snapshot,
  TicketOutcome,
  TicketSource,
  TicketUi,
  View,
} from "./model.js";

// ─── injected collaborators ───

export interface StoreLike {
  getState(): AppState;
  subscribe(fn: () => void): () => void;
  onAlert(fn: (a: Alert) => void): () => void;
  oiSeries(coin: string): Array<{ t: number; v: number }>;
  refreshAccount(): Promise<void>;
}

export interface AgentEventsLike {
  onText(delta: string): void;
  onToolStart(name: string, inputSummary: string): void;
  onToolEnd(name: string, ok: boolean, summary: string): void;
  onServerTool?(name: string, summary: string): void;
}

export interface AgentLike {
  ask(question: string, ev: AgentEventsLike, signal?: AbortSignal): Promise<{ text: string; stop: string }>;
  clear(): void;
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(h: unknown): void;
}

const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

export interface ControllerOptions {
  config: Config;
  store: StoreLike;
  info: InfoSource;
  exchange: Exchange | null;
  agent?: AgentLike | null;
  /** Model name for the status bar; ignored when agent is null. */
  agentLabel?: string;
  /** Why the agent is off (shown by /model). */
  agentReason?: string;
  /** Lab pulse; absent → "/pulse" explains how to enable. */
  pulse?: (() => Promise<Pulse>) | null;
  brief?: () => Promise<Brief | null>;
  now?: () => number;
  timers?: Timers;
  /** Coalescing window for streamed tokens and store updates; 0 = notify synchronously (tests). */
  batchMs?: number;
  /** Called once on /quit or a second Ctrl-C, after the agent is aborted and any ticket discarded. */
  onQuit?: () => void;
  ticketId?: () => string;
}

// ─── constants ───

export const QUIT_ARM_MS = 2000;
/** `y` is ignored this long after a ticket appears or is re-quoted (stray typing, key repeat). */
export const ARM_DELAY_MS = 500;
export const BOOK_POLL_MS = 3000;
const HISTORY_MAX = 200;
const DEMO_BLOCKER = "demo: orders disabled";

export const HELP: HelpItem[] = [
  { usage: "/markets [oi|vol|chg|funding] [filter]", summary: "live markets table (esc closes)" },
  { usage: "/coin COIN", summary: "funding, OI, ATR, regime and flow diagnostics" },
  { usage: "/book COIN", summary: "live order book, depth and slippage (esc closes)" },
  { usage: "/pos", summary: "positions and open orders" },
  { usage: "/long COIN [$usd|N% book|risk N%] stop <px|N%|Natr|pdl|pdh> [tp <px|N%|NR>] [Nx] [@px]", summary: "draft a long ticket" },
  { usage: "/short COIN …", summary: "draft a short ticket (same grammar)" },
  { usage: "/close COIN [pct]", summary: "reduce-only close ticket" },
  { usage: "/cancel <oid>|all [COIN]", summary: "cancel open orders (ticket)" },
  { usage: "/stop COIN <px>", summary: "replace the stop trigger (ticket)" },
  { usage: "/alerts", summary: "active alerts" },
  { usage: "/pulse", summary: "Lab market pulse" },
  { usage: "/brief", summary: "latest routine brief" },
  { usage: "/model", summary: "agent model" },
  { usage: "/clear", summary: "reset the agent's history" },
  { usage: "/help", summary: "this list" },
  { usage: "/quit", summary: "exit (ctrl-c twice also quits)" },
];

const HELP_SUMMARY: Record<string, string> = Object.fromEntries(HELP.map((h) => [h.usage.split(" ")[0]!, h.summary]));

/** A confirmed send and how it ended. */
export interface InFlight {
  ticket: Ticket;
  result: SendResult;
  outcome: "sent" | "failed" | "uncertain";
}

type NewEntry = Entry extends infer E ? (E extends Entry ? Omit<E, "id" | "at"> : never) : never;

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ─── pure helpers ───

/** Markets overlay rows: filtered (substring on coin) and sorted. */
export function sortMarkets(markets: MarketRow[], sort: SortKey, dir: "desc" | "asc", filter: string): MarketRow[] {
  const f = filter.trim().toLowerCase();
  const rows = f ? markets.filter((m) => m.coin.toLowerCase().includes(f)) : [...markets];
  const key: Record<SortKey, (m: MarketRow) => number> = {
    oi: (m) => m.oiUsd,
    vol: (m) => m.dayVolumeUsd,
    chg: (m) => Math.abs(m.dayChangePct),
    funding: (m) => Math.abs(m.fundingAprPct),
  };
  const k = key[sort];
  rows.sort((a, b) => (dir === "desc" ? k(b) - k(a) : k(a) - k(b)) || a.coin.localeCompare(b.coin));
  return rows;
}

function ticketLabel(t: Ticket): string {
  switch (t.action.kind) {
    case "open":
      return `${t.coin} ${t.side ?? ""}`.trim();
    case "close":
      return `close ${t.action.pct}% ${t.coin}`;
    case "cancel":
      return `cancel ${t.action.oids.length} order(s)`;
    case "stop":
      return `stop ${t.coin}`;
  }
}

/**
 * A send that did not succeed is "failed" only when nothing was posted (preflight
 * refusal, leverage update refused before any order). Anything else that is not ok
 * (fills, oids, status unknown, flatten paths, a thrown send) is "uncertain".
 */
export function sendOutcome(r: SendResult, threw = false): "sent" | "failed" | "uncertain" {
  if (r.ok && !threw) return "sent";
  if (threw || r.lines.length || r.oids.length || !r.errors.length) return "uncertain";
  return r.errors.every((e) => e.startsWith("not sent:") || /nothing was ordered/.test(e)) ? "failed" : "uncertain";
}

/** One-line outcome the agent sees at the start of its next question. */
export function agentOutcomeNote(t: Ticket, outcome: TicketOutcome, result?: SendResult): string {
  const head = `[ticket ${t.id} ${ticketLabel(t)}:`;
  const detail = result ? [...result.lines, ...result.errors.map((e) => `error: ${e}`)].join("; ") : "";
  switch (outcome) {
    case "sent":
      return `${head} confirmed by the human and sent${detail ? `; ${detail}` : ""}]`;
    case "failed":
      return `${head} confirmed by the human; not sent${detail ? `; ${detail}` : ""}]`;
    case "uncertain":
      return `${head} confirmed by the human; outcome uncertain, check /pos${detail ? `; ${detail}` : ""}]`;
    case "simulated":
      return `${head} confirmed in demo mode; simulated, nothing sent]`;
    case "discarded":
      return `${head} discarded by the human, not sent]`;
    case "dismissed":
      return `${head} dismissed by the human (it could not be sent), not sent]`;
  }
}

// ─── controller ───

export class Controller {
  private view: View;
  private readonly listeners = new Set<() => void>();
  private readonly cfg: Config;
  private readonly store: StoreLike;
  private readonly info: InfoSource;
  private readonly exchange: Exchange | null;
  private readonly agent: AgentLike | null;
  private readonly agentReason: string | undefined;
  private readonly pulseFn: (() => Promise<Pulse>) | null;
  private readonly briefFn: () => Promise<Brief | null>;
  private readonly now: () => number;
  private readonly timers: Timers;
  private readonly batchMs: number;
  private readonly onQuit: () => void;
  private readonly ticketId: (() => string) | undefined;

  private seq = 0;
  private history: string[] = [];
  private histIdx: number | null = null;
  private draft = "";
  private abort: AbortController | null = null;
  private agentNotes: string[] = [];
  private intentNotes: string[] = [];
  private quoting = false;
  private quitTimer: unknown = null;
  private bookTimer: unknown = null;
  private flushTimer: unknown = null;
  private lastAccountError: string | null = null;
  private unsubs: Array<() => void> = [];
  private quitting = false;
  private disposed = false;
  /** When the pending ticket was shown or last re-quoted (ARM_DELAY_MS gate). */
  private armedAt = 0;
  private inflight: Promise<InFlight> | null = null;
  private size = { cols: 100, rows: 30 };

  constructor(o: ControllerOptions) {
    this.cfg = o.config;
    this.store = o.store;
    this.info = o.info;
    this.exchange = o.exchange;
    this.agent = o.agent ?? null;
    this.agentReason = o.agentReason;
    this.pulseFn = o.pulse ?? null;
    this.briefFn = o.brief ?? (async () => null);
    this.now = o.now ?? Date.now;
    this.timers = o.timers ?? realTimers;
    this.batchMs = o.batchMs ?? 50;
    this.onQuit = o.onQuit ?? (() => {});
    this.ticketId = o.ticketId;

    const agentLabel = this.agent ? (o.agentLabel ?? "agent") : null;
    this.view = {
      state: this.store.getState(),
      entries: [],
      mode: "prompt",
      quitArmed: false,
      input: "",
      cursor: 0,
      completion: null,
      agentRun: null,
      busy: null,
      pending: null,
      overlay: null,
      agentLabel,
    };
    this.append({ kind: "banner", info: { network: this.cfg.network, account: this.cfg.account, canTrade: this.cfg.canTrade, demo: this.cfg.demo, agentLabel } });
    this.unsubs.push(
      this.store.subscribe(() => this.onStore()),
      this.store.onAlert((a) => this.append({ kind: "alert", alert: a })),
    );
    this.onStore();
  }

  // ─── subscription ───

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  getView = (): View => this.view;

  /** Terminal size, for paging and book levels. Does not notify. */
  resize(cols: number, rows: number): void {
    this.size = { cols, rows };
  }

  /** Detaches from the store and stops timers (no quit callback). */
  dispose(): void {
    this.disposed = true;
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.stopBookPoll();
    if (this.quitTimer) this.timers.clearTimeout(this.quitTimer);
    if (this.flushTimer) this.timers.clearTimeout(this.flushTimer);
    this.quitTimer = this.flushTimer = null;
  }

  private emit(urgent: boolean): void {
    if (this.disposed) return; // late set() after quit: no timers, nobody to render for
    if (urgent || this.batchMs <= 0) {
      if (this.flushTimer) {
        this.timers.clearTimeout(this.flushTimer);
        this.flushTimer = null;
      }
      for (const fn of this.listeners) {
        try {
          fn();
        } catch {}
      }
      return;
    }
    if (this.flushTimer) return;
    this.flushTimer = this.timers.setTimeout(() => {
      this.flushTimer = null;
      this.emit(true);
    }, this.batchMs);
  }

  private set(patch: Partial<View>, urgent = true): void {
    const v = { ...this.view, ...patch };
    v.mode = modeOf(v);
    this.view = v;
    this.emit(urgent);
  }

  private append(e: NewEntry, urgent = true): void {
    const entry = { id: `e${++this.seq}`, at: this.now(), ...e } as Entry;
    this.set({ entries: [...this.view.entries, entry] }, urgent);
  }

  private error(source: string, message: string, hint?: string): void {
    this.append({ kind: "error", source, message, ...(hint ? { hint } : {}) });
  }

  private note(text: string): void {
    this.append({ kind: "note", text });
  }

  private snapshot(s: Snapshot): void {
    this.append({ kind: "view-snapshot", ...s } as NewEntry);
  }

  private state(): AppState {
    return this.store.getState();
  }

  private onStore(): void {
    const s = this.state();
    if (s.accountError && s.accountError !== this.lastAccountError) {
      this.lastAccountError = s.accountError;
      this.set({ state: s }, false);
      this.error("account", s.accountError);
      return;
    }
    if (!s.accountError) this.lastAccountError = null;
    this.set({ state: s }, false);
  }

  private szDecimals(coin: string): number {
    return findMarket(this.state().markets, coin)?.szDecimals ?? 2;
  }

  private async busyDo<T>(label: string, fn: () => Promise<T>): Promise<T> {
    this.set({ busy: label });
    try {
      return await fn();
    } finally {
      this.set({ busy: null });
    }
  }

  // ─── input: submit ───

  /** Enter on the prompt. Resolves when the command's work (fetch, quote, agent turn) is done. */
  async submit(raw: string): Promise<void> {
    const text = raw.trim();
    const v = this.view;
    if (!text || v.pending || v.overlay || v.agentRun || v.busy || this.quitting) return;
    this.pushHistory(text);
    this.set({ input: "", cursor: 0, completion: null });
    this.append({ kind: "user", text });
    try {
      await this.dispatch(parseInput(text));
    } catch (e) {
      this.error("internal", errMsg(e));
    }
  }

  private pushHistory(text: string): void {
    if (this.history[this.history.length - 1] !== text) this.history.push(text);
    if (this.history.length > HISTORY_MAX) this.history.shift();
    this.histIdx = null;
    this.draft = "";
  }

  private async dispatch(cmd: Command): Promise<void> {
    const st = this.state();
    switch (cmd.kind) {
      case "noop":
        return;
      case "error":
        return this.error("parse", cmd.message, cmd.token ? `bad token: ${cmd.token}` : undefined);
      case "agent":
        return this.ask(cmd.text);
      case "markets":
        this.set({ overlay: { kind: "markets", sort: cmd.sort ?? "oi", dir: "desc", filter: cmd.filter ?? "", selected: 0, editing: null } });
        return;
      case "book":
        return this.openBook(cmd.coin, null);
      case "coin":
        return this.coin(cmd.coin);
      case "pos":
        return this.pos();
      case "order":
        return this.order(cmd);
      case "close":
        return this.quote({ kind: "close", coin: cmd.coin, pct: cmd.pct }, "command");
      case "cancel": {
        const orders = st.account?.orders ?? [];
        let oids: Array<{ coin: string; oid: number }>;
        if (cmd.target === "all") {
          oids = orders.filter((o) => !cmd.coin || o.coin.toUpperCase() === cmd.coin.toUpperCase()).map((o) => ({ coin: o.coin, oid: o.oid }));
          if (!oids.length && st.account) return this.note(`no open orders${cmd.coin ? ` on ${cmd.coin}` : ""} to cancel`);
        } else {
          const o = orders.find((x) => x.oid === cmd.target);
          oids = [{ coin: o?.coin ?? cmd.coin ?? "?", oid: cmd.target }];
        }
        return this.quote({ kind: "cancel", oids }, "command");
      }
      case "stop":
        return this.quote({ kind: "stop", coin: cmd.coin, px: cmd.px }, "command");
      case "alerts":
        return this.snapshot({ view: "alerts", data: st.alerts });
      case "pulse":
        return this.pulse();
      case "brief":
        return this.brief();
      case "model":
        return this.snapshot({ view: "model", data: { label: this.view.agentLabel, ...(this.agent ? {} : { reason: this.agentReason ?? "no LLM provider configured" }) } });
      case "clear":
        this.agent?.clear();
        this.agentNotes = [];
        return this.note(this.agent ? "agent history cleared" : "nothing to clear: agent off");
      case "help":
        return this.snapshot({ view: "help", data: HELP });
      case "quit":
        return this.quit();
    }
  }

  private unknownCoin(coin: string, source: string): void {
    const near = closestCoins(this.state().markets, coin);
    const loaded = this.state().markets.length > 0;
    this.error(source, loaded ? `unknown coin ${coin}` : `markets not loaded yet${this.state().marketsError ? ` (${this.state().marketsError})` : ""}`, near.length ? `closest: ${near.join(", ")}` : undefined);
  }

  private async coin(coin: string): Promise<void> {
    const m = findMarket(this.state().markets, coin);
    if (!m) return this.unknownCoin(coin, "coin");
    try {
      const view = await this.busyDo(`loading ${m.coin}…`, () => buildCoinView(this.info, m, this.state().account, this.now(), this.store.oiSeries(m.coin)));
      this.snapshot({ view: "coin", data: view });
    } catch (e) {
      this.error("coin", errMsg(e));
    }
  }

  private async pos(): Promise<void> {
    const configured = this.cfg.account != null;
    if (configured && !this.state().account && !this.state().accountError) {
      await this.busyDo("fetching account…", () => this.store.refreshAccount()).catch(() => {});
    }
    const st = this.state();
    if (configured && !st.account) return this.error("account", st.accountError ?? "account not loaded");
    const szDecimals = Object.fromEntries(st.markets.map((m) => [m.coin, m.szDecimals]));
    this.snapshot({ view: "pos", data: { account: st.account, configured, szDecimals } });
  }

  private async pulse(): Promise<void> {
    if (!this.pulseFn) return this.note("lab not configured — set LAB_URL and LAB_API_TOKEN");
    const fn = this.pulseFn;
    try {
      const p = await this.busyDo("fetching lab pulse…", fn);
      this.snapshot({ view: "pulse", data: p });
    } catch (e) {
      this.error("pulse", errMsg(e));
    }
  }

  private async brief(): Promise<void> {
    try {
      const b = await this.briefFn();
      if (!b) return this.note("no brief at data/marketstate/latest.json");
      this.snapshot({ view: "brief", data: b });
    } catch (e) {
      this.error("brief", errMsg(e));
    }
  }

  // ─── tickets ───

  private ticketDeps(): TicketDeps {
    const st = this.state();
    return {
      config: this.cfg,
      info: this.info,
      markets: st.markets,
      account: st.account,
      now: () => new Date(this.now()),
      ...(this.ticketId ? { id: this.ticketId } : {}),
    };
  }

  private async order(cmd: OrderCommand): Promise<void> {
    const st = this.state();
    const m = findMarket(st.markets, cmd.coin);
    if (!m) return this.unknownCoin(cmd.coin, "order");
    // Risk sizing (explicit or default) goes through buildTicket's riskPct, which works
    // for every stop type; the intent's size is a placeholder that riskPct overrides.
    const riskSized = !cmd.size || "riskPct" in cmd.size;
    const riskPct = cmd.size && "riskPct" in cmd.size ? cmd.size.riskPct : this.cfg.limits.maxRiskPct;
    const r = orderToIntent(riskSized ? { ...cmd, size: { usd: 1 } } : cmd, {
      markPx: livePx(m),
      equityUsd: st.account?.equityUsd ?? 0,
      defaultLeverage: this.cfg.defaultLeverage,
      defaultRiskPct: riskPct,
    });
    if (!r.ok) return this.error("order", r.error);
    const action: TicketRequest = riskSized ? { kind: "open", intent: r.intent, riskPct } : { kind: "open", intent: r.intent };
    await this.quote(action, "command", r.notes);
  }

  private async quote(action: TicketRequest, source: TicketSource, notes: string[] = []): Promise<void> {
    if (this.view.pending || this.quoting) return this.error("ticket", "a ticket is already pending");
    this.quoting = true;
    try {
      const t = await this.busyDo("quoting…", () => buildTicket(action, this.ticketDeps()));
      this.openTicket(t, source, notes);
    } catch (e) {
      this.error("ticket", errMsg(e));
    } finally {
      this.quoting = false;
    }
  }

  private uiFor(t: Ticket, source: TicketSource): TicketUi {
    const pos = this.state().account?.positions.find((p) => p.coin === t.coin);
    return {
      phase: "awaiting",
      source,
      access: this.cfg.demo ? "demo" : this.cfg.canTrade ? "trade" : "read-only",
      slippage: this.cfg.slippage,
      szDecimals: this.szDecimals(t.coin),
      ...(t.action.kind === "stop" ? { oldStopPx: pos?.stopPx ?? null } : {}),
    };
  }

  private withIntentNotes(t: Ticket): Ticket {
    return this.intentNotes.length ? { ...t, notes: [...t.notes, ...this.intentNotes.filter((n) => !t.notes.includes(n))] } : t;
  }

  private openTicket(t: Ticket, source: TicketSource, notes: string[]): void {
    if (this.view.overlay) this.closeOverlay(true);
    this.intentNotes = notes;
    this.armedAt = this.now();
    this.set({ pending: { ticket: this.withIntentNotes(t), ui: this.uiFor(t, source) } });
  }

  /**
   * agent draft_order / draft_close: builds the ticket and puts it up for the
   * human exactly like a slash order; returns at once (never waits for `y`).
   * While a ticket is pending, returns that ticket with a warning instead.
   */
  async draftOrder(action: TicketAction): Promise<Ticket> {
    const p = this.view.pending;
    if (p) {
      return { ...p.ticket, warnings: [`a ticket is already pending (${p.ticket.id}): this new draft was NOT shown; the human must resolve ${p.ticket.id} first`, ...p.ticket.warnings] };
    }
    if (this.quoting) throw new Error("a ticket is already being quoted; try again after the human resolves it");
    this.quoting = true;
    try {
      const t = await buildTicket(action, this.ticketDeps());
      this.openTicket(t, "agent", []);
      return t;
    } finally {
      this.quoting = false;
    }
  }

  private setPending(p: PendingTicket | null): void {
    this.set({ pending: p });
  }

  /** An order the human confirmed whose send has not returned yet (main awaits it on exit). */
  inFlight(): Promise<InFlight> | null {
    return this.inflight;
  }

  private async confirm(): Promise<void> {
    const p = this.view.pending;
    if (!p || p.ui.phase !== "awaiting" || this.quitting) return;
    if (this.now() - this.armedAt < ARM_DELAY_MS) return;
    const { ticket, ui } = p;
    if (ui.access === "demo") return this.simulate(ticket, ui);
    if (!ticket.canSend || ui.access !== "trade") return;
    if (!this.exchange) return this.error("send", "no exchange: trading key not loaded");
    const exchange = this.exchange;
    // After every await: the human may have quit, or the ticket may be gone.
    const stale = () => this.quitting || this.view.pending?.ticket.id !== ticket.id;

    this.setPending({ ticket, ui: { ...ui, phase: "requoting" } });
    let rq;
    try {
      rq = await requote(ticket, this.ticketDeps());
    } catch (e) {
      if (stale()) return;
      this.setPending({ ticket, ui: { ...ui, phase: "awaiting" } });
      return this.error("requote", errMsg(e));
    }
    if (stale()) return;
    const next = this.withIntentNotes(rq.ticket);
    if (rq.kind === "changed") {
      this.armedAt = this.now();
      this.setPending({ ticket: next, ui: { ...ui, phase: "awaiting", changedWhy: rq.why, previous: ticket } });
      return;
    }
    if (!next.canSend) {
      this.setPending({ ticket: next, ui: { ...ui, phase: "awaiting" } });
      return;
    }
    this.setPending({ ticket: next, ui: { ...ui, phase: "sending" } });
    const markets = this.state().markets;
    const sending: Promise<InFlight> = exchange.send(next, markets).then(
      (result) => ({ ticket: next, result, outcome: sendOutcome(result) }),
      (e: unknown) => {
        const result: SendResult = { ok: false, lines: [], errors: [errMsg(e)], oids: [] };
        return { ticket: next, result, outcome: sendOutcome(result, true) };
      },
    );
    this.inflight = sending;
    const done = await sending;
    if (this.inflight === sending) this.inflight = null;
    if (this.quitting) return; // main prints the outcome after the UI is gone
    if (this.view.pending?.ticket.id !== next.id) return;
    this.resolveTicket(next, ui, done.outcome, done.result);
    try {
      await this.store.refreshAccount();
    } catch {}
  }

  private simulate(t: Ticket, ui: TicketUi): void {
    const sz = t.size != null ? fmtSz(t.size, ui.szDecimals) : "";
    const what =
      t.action.kind === "open"
        ? `would ${t.side === "short" ? "sell" : "buy"} ${sz} ${t.coin} ≈ ${fmtUsd(t.notionalUsd)} at ~${fmtPx(t.entryPx, ui.szDecimals)}${t.stopPx != null ? `, stop ${fmtPx(t.stopPx, ui.szDecimals, t.entryPx ?? undefined)}` : ""}${t.tpPx != null ? `, tp ${fmtPx(t.tpPx, ui.szDecimals, t.entryPx ?? undefined)}` : ""}`
        : t.action.kind === "close"
          ? `would close ${sz} ${t.coin} reduce-only`
          : t.action.kind === "cancel"
            ? `would cancel ${t.action.oids.map((o) => o.oid).join(", ")}`
            : `would move the ${t.coin} stop to ${fmtPx(t.stopPx, ui.szDecimals)}`;
    // A ticket the live path would refuse is simulated as refused, so the demo shows the governor at work.
    const refused = t.blockers.filter((b) => b !== DEMO_BLOCKER);
    const result: SendResult = refused.length
      ? { ok: false, lines: ["demo: simulated, nothing sent"], errors: refused.map((b) => `demo: would be refused: ${b}`), oids: [] }
      : { ok: true, lines: ["demo: simulated, nothing sent", `demo: ${what}`], errors: [], oids: [] };
    this.resolveTicket(t, ui, "simulated", result);
  }


  private discard(): void {
    const p = this.view.pending;
    if (!p || p.ui.phase === "requoting" || p.ui.phase === "sending") return;
    const sendable = p.ui.access === "demo" || (p.ticket.canSend && p.ui.access === "trade");
    this.resolveTicket(p.ticket, p.ui, sendable ? "discarded" : "dismissed");
  }

  private resolveTicket(t: Ticket, ui: TicketUi, outcome: TicketOutcome, result?: SendResult): void {
    this.intentNotes = [];
    this.set({ pending: null });
    this.append({ kind: "ticket", ticket: t, outcome, ui: { ...ui, phase: "frozen", outcome } });
    if (result) this.append({ kind: "result", result, ticketId: t.id, demo: outcome === "simulated", outcome });
    if (ui.source === "agent") this.agentNotes.push(agentOutcomeNote(t, outcome, result));
  }

  // ─── agent ───

  private async ask(text: string): Promise<void> {
    if (!this.agent) {
      return this.error("agent", "agent unavailable — no LLM provider configured (set ANTHROPIC_API_KEY or ANALYST_PROVIDER); slash commands still work");
    }
    const question = this.agentNotes.length ? `${this.agentNotes.join("\n")}\n${text}` : text;
    this.agentNotes = [];
    const ac = new AbortController();
    this.abort = ac;
    this.set({ agentRun: { startedAt: this.now(), text: "", flushed: false, tools: [] } });
    const run = () => this.view.agentRun;
    const patchRun = (p: Partial<AgentRun>, urgent = false) => {
      const r = run();
      if (r) this.set({ agentRun: { ...r, ...p } }, urgent);
    };
    const flush = () => {
      const r = run();
      if (!r) return;
      const t = r.text.trim();
      if (t) {
        this.append({ kind: "agent-text", text: t, ...(r.flushed ? { cont: true } : {}) }, false);
        patchRun({ text: "", flushed: true });
      } else if (r.text) patchRun({ text: "" });
    };
    const ev: AgentEventsLike = {
      onText: (d) => {
        const r = run();
        if (!r) return;
        let buf = r.text + d;
        const cut = buf.lastIndexOf("\n\n");
        if (cut >= 0) {
          let flushed = r.flushed;
          for (const para of buf.slice(0, cut).split(/\n{2,}/)) {
            const p = para.trim();
            if (!p) continue;
            this.append({ kind: "agent-text", text: p, ...(flushed ? { cont: true } : {}) }, false);
            flushed = true;
          }
          buf = buf.slice(cut + 2);
          patchRun({ text: buf, flushed });
        } else patchRun({ text: buf });
      },
      onToolStart: (name, args) => {
        flush();
        const r = run();
        if (r) patchRun({ flushed: false, tools: [...r.tools, { name, args, startedAt: this.now() }] }, true);
      },
      onToolEnd: (name, ok, summary) => {
        const r = run();
        if (!r) return;
        const i = r.tools.findIndex((t) => t.name === name);
        const t = i >= 0 ? r.tools[i]! : { name, args: "", startedAt: this.now() };
        patchRun({ tools: r.tools.filter((_, j) => j !== i) }, true);
        this.append({ kind: "tool-line", name, args: t.args, status: ok ? "ok" : "error", ms: this.now() - t.startedAt, ...(ok ? {} : { error: summary }) });
      },
      onServerTool: (name, summary) => {
        flush();
        this.append({ kind: "tool-line", name, args: summary, status: "ok" });
      },
    };

    let stop = "end";
    try {
      const res = await this.agent.ask(question, ev, ac.signal);
      stop = res.stop;
    } catch (e) {
      flush();
      this.error("agent", errMsg(e));
      stop = "error";
    } finally {
      flush();
      for (const t of run()?.tools ?? []) this.append({ kind: "tool-line", name: t.name, args: t.args, status: "aborted", ms: this.now() - t.startedAt });
      this.abort = null;
      this.set({ agentRun: null });
    }
    if (stop === "aborted") this.note("aborted");
    else if (stop === "timeout") this.note("timed out after 120s");
    else if (stop === "max_rounds") this.note("stopped after 8 tool rounds");
    else if (stop === "max_tokens") this.note("stopped: the answer hit the token limit");
    else if (stop === "refusal") this.note("stopped: the model declined to answer");
  }

  // ─── overlays ───

  private bookLevels(): number {
    return bookLevels(overlayHeight(this.size.rows));
  }

  private async openBook(coin: string, back: MarketsOverlay | null): Promise<void> {
    const m = findMarket(this.state().markets, coin);
    if (!m) return this.unknownCoin(coin, "book");
    this.stopBookPoll();
    this.set({ overlay: { kind: "book", coin: m.coin, levels: this.bookLevels(), book: null, error: null, back } });
    this.bookTimer = this.timers.setInterval(() => void this.fetchBook(m.coin), BOOK_POLL_MS);
    await this.fetchBook(m.coin);
  }

  private async fetchBook(coin: string): Promise<void> {
    try {
      const book = await this.info.book(coin);
      const o = this.view.overlay;
      if (o?.kind === "book" && o.coin === coin) this.set({ overlay: { ...o, book, error: null } }, false);
    } catch (e) {
      const o = this.view.overlay;
      if (o?.kind === "book" && o.coin === coin) this.set({ overlay: { ...o, error: errMsg(e) } });
    }
  }

  private stopBookPoll(): void {
    if (this.bookTimer) this.timers.clearInterval(this.bookTimer);
    this.bookTimer = null;
  }

  /** Esc/q: book appends its summary; a book opened from markets returns there (unless `all`). */
  private closeOverlay(all = false): void {
    const o = this.view.overlay;
    if (!o) return;
    let next: Overlay | null = null;
    if (o.kind === "book") {
      this.stopBookPoll();
      if (o.book) this.snapshot({ view: "book-summary", data: { book: o.book, szDecimals: this.szDecimals(o.coin) } });
      if (!all) next = o.back;
    }
    this.set({ overlay: next });
  }

  private marketsRows(o: MarketsOverlay): MarketRow[] {
    return sortMarkets(this.state().markets, o.sort, o.dir, o.filter);
  }

  private async marketsKey(o: MarketsOverlay, input: string, key: KeyLike): Promise<void> {
    if (o.editing != null) {
      if (key.escape) this.set({ overlay: { ...o, editing: null } });
      else if (key.return) this.set({ overlay: { ...o, filter: o.editing.trim(), editing: null, selected: 0 } });
      else if (key.backspace || key.delete) this.set({ overlay: { ...o, editing: o.editing.slice(0, -1) } });
      else if (input && !key.ctrl && !key.meta) {
        const nl = input.search(/[\r\n]/);
        const text = o.editing + clean(nl >= 0 ? input.slice(0, nl) : input);
        if (nl >= 0) this.set({ overlay: { ...o, filter: text.trim(), editing: null, selected: 0 } });
        else this.set({ overlay: { ...o, editing: text } });
      }
      return;
    }
    const rows = this.marketsRows(o);
    const last = Math.max(0, rows.length - 1);
    const page = Math.max(1, this.size.rows - 5);
    const sel = (n: number) => this.set({ overlay: { ...o, selected: Math.max(0, Math.min(last, n)) } });
    const sortKeys: Record<string, SortKey> = { o: "oi", v: "vol", c: "chg", f: "funding" };
    if (key.escape || input === "q") return this.closeOverlay();
    if (key.upArrow || input === "k") return sel(o.selected - 1);
    if (key.downArrow || input === "j") return sel(o.selected + 1);
    if (key.pageUp) return sel(o.selected - page);
    if (key.pageDown) return sel(o.selected + page);
    if (input === "g") return sel(0);
    if (input === "G") return sel(last);
    if (input === "/") return this.set({ overlay: { ...o, editing: o.filter } });
    const sk = sortKeys[input];
    if (sk) {
      const dir = sk === o.sort ? (o.dir === "desc" ? "asc" : "desc") : "desc";
      return this.set({ overlay: { ...o, sort: sk, dir, selected: 0 } });
    }
    const row = rows[Math.min(o.selected, last)];
    if (key.return && row) {
      this.set({ overlay: null });
      return this.submit(`/coin ${row.coin}`);
    }
    if (input === "b" && row) return this.openBook(row.coin, o);
  }

  private bookKey(o: BookOverlay, input: string, key: KeyLike): void {
    if (key.escape || input === "q") return this.closeOverlay();
    if (input === "+" || input === "=") this.set({ overlay: { ...o, levels: Math.min(bookMaxLevels(overlayHeight(this.size.rows)), o.levels + 1) } });
    else if (input === "-" || input === "_") this.set({ overlay: { ...o, levels: Math.max(1, o.levels - 1) } });
  }

  // ─── keys ───

  /** One key event from Ink. Resolves when any work it started is done. */
  async key(input: string, key: KeyLike): Promise<void> {
    try {
      if (key.ctrl && input === "c") return this.ctrlC();
      const v = this.view;
      if (v.pending) {
        // Exactly y / n / Esc: Ctrl-Y, Alt-Y and pasted chunks such as "yes" or "y\r" never confirm.
        if (key.ctrl || key.meta) return;
        if (key.escape || input === "n" || input === "N") return this.discard();
        if (input === "y" || input === "Y") return await this.confirm();
        return; // typed keys are dropped, not buffered
      }
      if (v.overlay) {
        if (v.overlay.kind === "markets") return await this.marketsKey(v.overlay, input, key);
        return this.bookKey(v.overlay, input, key);
      }
      if (v.agentRun && key.escape && !v.completion) {
        this.abort?.abort();
        return;
      }
      return await this.promptKey(input, key);
    } catch (e) {
      this.error("internal", errMsg(e));
    }
  }

  private ctrlC(): void {
    if (this.quitting) return;
    if (this.view.quitArmed) return this.quit();
    if (this.quitTimer) this.timers.clearTimeout(this.quitTimer);
    this.quitTimer = this.timers.setTimeout(() => {
      this.quitTimer = null;
      this.set({ quitArmed: false });
    }, QUIT_ARM_MS);
    this.set({ quitArmed: true });
  }

  /**
   * /quit or a second Ctrl-C: abort the agent, discard an awaiting ticket, stop polls,
   * then onQuit. A ticket being re-quoted is never sent after this; one already being
   * sent is left to finish (see inFlight()).
   */
  quit(): void {
    if (this.quitting) return;
    this.quitting = true;
    this.abort?.abort();
    const p = this.view.pending;
    if (p?.ui.phase === "sending") this.note(`order in flight (ticket ${p.ticket.id}): check /pos after restart`);
    else if (p?.ui.phase === "requoting") this.note(`ticket ${p.ticket.id} abandoned while re-quoting: not sent`);
    else if (p) this.resolveTicket(p.ticket, p.ui, "discarded");
    if (this.view.overlay) this.closeOverlay(true);
    this.set({ quitArmed: false });
    this.dispose();
    try {
      this.onQuit();
    } catch {}
  }

  private setInput(input: string, cursor = input.length): void {
    this.set({ input, cursor: Math.max(0, Math.min(input.length, cursor)) });
  }

  private async promptKey(input: string, key: KeyLike): Promise<void> {
    const v = this.view;
    const c = v.completion;
    if (c) {
      const n = c.items.length;
      if (key.tab || key.downArrow) return this.set({ completion: { ...c, selected: (c.selected + 1) % n } });
      if (key.upArrow) return this.set({ completion: { ...c, selected: (c.selected - 1 + n) % n } });
      if (key.return) {
        const text = `${c.head}${c.items[c.selected]!.label} `;
        return this.set({ input: text, cursor: text.length, completion: null });
      }
      if (key.escape) return this.set({ completion: null });
      this.set({ completion: null });
    }
    const { input: val, cursor } = this.view;
    if (key.return) return this.submit(val);
    if (key.tab) return this.complete();
    if (key.upArrow) return this.historyMove(-1);
    if (key.downArrow) return this.historyMove(1);
    if (key.leftArrow) return this.setInput(val, cursor - 1);
    if (key.rightArrow) return this.setInput(val, cursor + 1);
    if (key.home || (key.ctrl && input === "a")) return this.setInput(val, 0);
    if (key.end || (key.ctrl && input === "e")) return this.setInput(val, val.length);
    if (key.ctrl && input === "u") return this.setInput("", 0);
    if (key.backspace || key.delete) {
      if (cursor === 0) return;
      return this.setInput(val.slice(0, cursor - 1) + val.slice(cursor), cursor - 1);
    }
    if (key.escape) return this.setInput("", 0);
    if (input && !key.ctrl && !key.meta) {
      // A chunk with a newline (paste, or text + Enter in one read): insert what precedes it, then submit.
      const nl = input.search(/[\r\n]/);
      const text = clean(nl >= 0 ? input.slice(0, nl) : input);
      const line = val.slice(0, cursor) + text + val.slice(cursor);
      if (nl < 0) {
        if (text) this.setInput(line, cursor + text.length);
        return;
      }
      const rest = clean(input.slice(nl).replace(/[\r\n]+/g, " ")).trim();
      if (this.view.agentRun) return this.setInput(rest ? `${line} ${rest}` : line); // Enter is ignored while the agent runs
      await this.submit(line);
      if (rest && !this.view.pending) this.setInput(rest);
    }
  }

  private historyMove(dir: -1 | 1): void {
    if (!this.history.length) return;
    if (dir < 0) {
      if (this.histIdx == null) {
        this.draft = this.view.input;
        this.histIdx = this.history.length - 1;
      } else this.histIdx = Math.max(0, this.histIdx - 1);
      return this.setInput(this.history[this.histIdx]!);
    }
    if (this.histIdx == null) return;
    if (this.histIdx >= this.history.length - 1) {
      this.histIdx = null;
      return this.setInput(this.draft);
    }
    this.histIdx++;
    this.setInput(this.history[this.histIdx]!);
  }

  private complete(): void {
    const st = this.state();
    const byOi = [...st.markets].sort((a, b) => b.oiUsd - a.oiUsd);
    const input = this.view.input;
    const r = complete(input, { coins: byOi.map((m) => m.coin), oids: st.account?.orders.map((o) => o.oid) ?? [] });
    if (!r.options.length) return;
    if (r.options.length === 1) return this.setInput(r.completed);
    const cur = input.split(/\s+/).pop() ?? "";
    const head = input.slice(0, input.length - cur.length);
    const items = r.options.map((label) => {
      const m = byOi.find((x) => x.coin === label);
      const detail = m ? fmtPx(livePx(m), m.szDecimals) : (HELP_SUMMARY[label] ?? HELP_SUMMARY[`/${aliasTarget(label)}`] ?? "");
      return { label, detail };
    });
    this.set({ input: r.completed, cursor: r.completed.length, completion: { items, selected: 0, head } });
  }
}

const ALIAS_OF: Record<string, string> = { p: "pos", m: "markets", b: "book", q: "quit", h: "help", buy: "long", sell: "short" };
const aliasTarget = (label: string) => ALIAS_OF[label.slice(1)] ?? label.slice(1);

/** Drops control characters (escape sequences, newlines) from typed or pasted text. */
const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f]/g, "");

function modeOf(v: View): Mode {
  if (v.pending) return "ticket";
  if (v.overlay) return "overlay";
  if (v.agentRun) return "agent";
  return "prompt";
}

// ─── agent deps ───

export interface AgentDepsInput {
  store: StoreLike;
  info: InfoSource;
  pulse: (() => Promise<Pulse>) | null;
  brief: () => Promise<Brief | null>;
  /** Resolved lazily: the controller is built after the agent. */
  controller: () => Controller;
}

/** The AgentDeps shape agent/tools.ts expects, wired to the store and the controller's ticket flow. */
export function makeAgentDeps(i: AgentDepsInput) {
  return {
    getState: () => i.store.getState(),
    info: i.info,
    oiSeries: (coin: string) => i.store.oiSeries(coin),
    pulse: async (): Promise<unknown> => {
      if (!i.pulse) throw new Error("lab not configured: set LAB_URL and LAB_API_TOKEN");
      return i.pulse();
    },
    brief: (): Promise<unknown | null> => i.brief(),
    draftOrder: (action: TicketAction) => i.controller().draftOrder(action),
  };
}
