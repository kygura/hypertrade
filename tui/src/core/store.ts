// AppState owner: polls markets and the account, folds in WS mids, runs the
// alert engine, and notifies subscribers. Nothing here throws out of a timer.
import { z } from "zod";
import { HlSocket, type HlSocketState, type HlSub } from "../../../src/shared/hl-ws.js";
import { AlertEngine } from "./alerts.js";
import { demoAccountAddress } from "./demo.js";
import type { Alert, AppState, Config, InfoSource, MarketRow, WsState } from "./types.js";

export interface SocketLike {
  subscribe(sub: HlSub, handler: (data: unknown) => void): () => void;
  stop(): void;
  onState(cb: (s: HlSocketState) => void): () => void;
}

export interface StoreOptions {
  config: Config;
  info: InfoSource;
  /** Builds the WS client for a URL. Default: HlSocket. Never called in demo mode. */
  socket?: (url: string) => SocketLike;
  alerts?: AlertEngine;
  now?: () => number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  /** One-shot timer for the trailing notification. Default: global setTimeout. */
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  marketsEveryMs?: number;
  accountEveryMs?: number;
}

const MIN_NOTIFY_GAP_MS = 250;
/** A WS mid older than this is not used, even if the socket still looks open. */
const MID_TTL_MS = 10_000;
const MidsMessage = z.object({ mids: z.record(z.string(), z.string()) });

export const wsUrl = (network: Config["network"]) => (network === "mainnet" ? "wss://api.hyperliquid.xyz/ws" : "wss://api.hyperliquid-testnet.xyz/ws");

/** A throwing listener must not break polling or other listeners. */
const safely = (fn: () => void) => {
  try {
    fn();
  } catch {}
};

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class Store {
  private state: AppState;
  private readonly cfg: Config;
  private readonly info: InfoSource;
  private readonly engine: AlertEngine;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (h: unknown) => void;
  private readonly setOnce: (fn: () => void, ms: number) => unknown;
  private readonly clearOnce: (h: unknown) => void;
  private readonly makeSocket: (url: string) => SocketLike;
  private readonly marketsEveryMs: number;
  private readonly accountEveryMs: number;
  private readonly listeners = new Set<() => void>();
  private readonly alertListeners = new Set<(a: Alert) => void>();
  private timers: unknown[] = [];
  private socket: SocketLike | null = null;
  /** Latest WS mid per coin with its arrival time. */
  private mids = new Map<string, { px: number; at: number }>();
  private lastNotify = 0;
  private trailing: unknown = null;
  /** Bumped by start() and stop(): a poll that began under an older generation drops its result. */
  private gen = 0;
  private busy = { markets: false, account: false };

  constructor(o: StoreOptions) {
    this.cfg = o.config;
    this.info = o.info;
    this.engine = o.alerts ?? new AlertEngine({ venue: o.config.network });
    this.now = o.now ?? Date.now;
    this.setTimer = o.setInterval ?? ((fn, ms) => setInterval(fn, ms));
    this.clearTimer = o.clearInterval ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
    this.setOnce = o.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearOnce = o.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.makeSocket = o.socket ?? ((url) => new HlSocket({ url }));
    this.marketsEveryMs = o.marketsEveryMs ?? 15_000;
    this.accountEveryMs = o.accountEveryMs ?? 10_000;
    this.state = { config: o.config, markets: [], marketsAt: null, marketsError: null, account: null, accountError: null, alerts: [], ws: o.config.demo ? "off" : "closed" };
  }

  getState(): AppState {
    return this.state;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onAlert(fn: (a: Alert) => void): () => void {
    this.alertListeners.add(fn);
    return () => this.alertListeners.delete(fn);
  }

  /** OI history the alert engine has for a coin (feeds coin.ts diagnostics). */
  oiSeries(coin: string): Array<{ t: number; v: number }> {
    return this.engine.oiSeries(coin);
  }

  /** Starts the polls and the socket, then resolves once the first markets and account reads have settled. */
  async start(): Promise<void> {
    if (this.timers.length) return;
    const gen = ++this.gen;
    this.timers.push(
      this.setTimer(() => void this.refreshMarkets(), this.marketsEveryMs),
      this.setTimer(() => void this.refreshAccount(), this.accountEveryMs),
    );
    if (!this.cfg.demo) this.openSocket();
    await this.loadMarkets();
    if (gen !== this.gen) return;
    await this.refreshAccount();
    if (gen === this.gen) this.evaluate();
  }

  stop(): void {
    this.gen++;
    this.busy = { markets: false, account: false };
    for (const t of this.timers) this.clearTimer(t);
    this.timers = [];
    this.clearTrailing();
    this.socket?.stop();
    this.socket = null;
    this.mids.clear();
    if (!this.cfg.demo) this.patch({ ws: "closed", markets: this.withMids(this.state.markets) });
  }

  async refreshMarkets(): Promise<void> {
    const gen = this.gen;
    if ((await this.loadMarkets()) && gen === this.gen) this.evaluate();
  }

  async refreshAccount(): Promise<void> {
    const address = this.cfg.account ?? (this.cfg.demo ? demoAccountAddress : null);
    if (!address || this.busy.account) return;
    const gen = this.gen;
    this.busy.account = true;
    try {
      const account = await this.info.account(address, this.state.markets);
      if (gen === this.gen) this.patch({ account, accountError: null });
    } catch (e) {
      if (gen === this.gen) this.patch({ accountError: errMsg(e) });
    } finally {
      if (gen === this.gen) this.busy.account = false;
    }
  }

  private async loadMarkets(): Promise<boolean> {
    if (this.busy.markets) return false;
    const gen = this.gen;
    this.busy.markets = true;
    try {
      const rows = await this.info.markets();
      if (gen !== this.gen) return false;
      const at = this.now();
      this.patch({ markets: this.withMids(rows, at), marketsAt: at, marketsError: null });
      return true;
    } catch (e) {
      if (gen === this.gen) this.patch({ marketsError: errMsg(e) }); // keep the last markets; the status bar shows their age
      return false;
    } finally {
      if (gen === this.gen) this.busy.markets = false;
    }
  }

  /** Runs the alert engine over the current state and publishes new alerts. */
  private evaluate(): void {
    let fresh: Alert[] = [];
    try {
      fresh = this.engine.ingest(this.now(), this.state.markets, this.state.account, this.cfg.watch);
    } catch {
      return;
    }
    this.patch({ alerts: this.engine.active() });
    for (const a of fresh) for (const fn of this.alertListeners) safely(() => fn(a));
  }

  /**
   * midPx is a WS mid only while it is fresh (within MID_TTL_MS) and newer than
   * the last poll; otherwise null, so nothing prices off a stale mid.
   */
  private withMids(rows: MarketRow[], marketsAt: number | null = this.state.marketsAt): MarketRow[] {
    const now = this.now();
    return rows.map((m) => {
      const mid = this.mids.get(m.coin);
      const px = mid && now - mid.at <= MID_TTL_MS && (marketsAt == null || mid.at >= marketsAt) ? mid.px : null;
      return m.midPx === px ? m : { ...m, midPx: px };
    });
  }

  private openSocket(): void {
    const sock = this.makeSocket(wsUrl(this.cfg.network));
    this.socket = sock;
    this.patch({ ws: "connecting" });
    sock.onState((s) => {
      if (this.socket !== sock) return;
      if (s !== "open") this.mids.clear(); // nothing live behind these any more
      this.patch({ ws: s satisfies WsState, ...(s !== "open" ? { markets: this.withMids(this.state.markets) } : {}) });
    });
    sock.subscribe({ type: "allMids" }, (data) => {
      if (this.socket !== sock) return;
      const msg = MidsMessage.safeParse(data);
      if (!msg.success) return;
      const at = this.now();
      let changed = false;
      for (const [coin, px] of Object.entries(msg.data.mids)) {
        const v = Number(px);
        if (!Number.isFinite(v) || v <= 0) continue;
        if (this.mids.get(coin)?.px !== v) changed = true;
        this.mids.set(coin, { px: v, at });
      }
      if (changed) this.patch({ markets: this.withMids(this.state.markets) }, true);
    });
  }

  /**
   * Replace state and tell subscribers. `throttle` caps notifications at ~4/s;
   * a throttled update schedules one trailing notification so the last one is
   * never lost. The state itself always updates immediately.
   */
  private patch(p: Partial<AppState>, throttle = false): void {
    this.state = { ...this.state, ...p };
    const t = this.now();
    const wait = MIN_NOTIFY_GAP_MS - (t - this.lastNotify);
    if (throttle && wait > 0) {
      if (this.trailing == null) {
        this.trailing = this.setOnce(() => {
          this.trailing = null;
          this.notify();
        }, wait);
      }
      return;
    }
    this.clearTrailing();
    this.notify();
  }

  private notify(): void {
    this.lastNotify = this.now();
    for (const fn of this.listeners) safely(fn);
  }

  private clearTrailing(): void {
    if (this.trailing != null) this.clearOnce(this.trailing);
    this.trailing = null;
  }
}
