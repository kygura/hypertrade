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
  marketsEveryMs?: number;
  accountEveryMs?: number;
}

const MIN_NOTIFY_GAP_MS = 250;
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
  private readonly makeSocket: (url: string) => SocketLike;
  private readonly marketsEveryMs: number;
  private readonly accountEveryMs: number;
  private readonly listeners = new Set<() => void>();
  private readonly alertListeners = new Set<(a: Alert) => void>();
  private timers: unknown[] = [];
  private socket: SocketLike | null = null;
  private mids = new Map<string, number>();
  private lastNotify = 0;
  private busy = { markets: false, account: false };

  constructor(o: StoreOptions) {
    this.cfg = o.config;
    this.info = o.info;
    this.engine = o.alerts ?? new AlertEngine({ venue: o.config.network });
    this.now = o.now ?? Date.now;
    this.setTimer = o.setInterval ?? ((fn, ms) => setInterval(fn, ms));
    this.clearTimer = o.clearInterval ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
    this.makeSocket = o.socket ?? ((url) => new HlSocket({ url }));
    this.marketsEveryMs = o.marketsEveryMs ?? 15_000;
    this.accountEveryMs = o.accountEveryMs ?? 10_000;
    this.state = { config: o.config, markets: [], marketsAt: null, account: null, accountError: null, alerts: [], ws: o.config.demo ? "off" : "closed" };
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
    this.timers.push(
      this.setTimer(() => void this.refreshMarkets(), this.marketsEveryMs),
      this.setTimer(() => void this.refreshAccount(), this.accountEveryMs),
    );
    if (!this.cfg.demo) this.openSocket();
    await this.loadMarkets();
    await this.refreshAccount();
    this.evaluate();
  }

  stop(): void {
    for (const t of this.timers) this.clearTimer(t);
    this.timers = [];
    this.socket?.stop();
    this.socket = null;
    if (!this.cfg.demo) this.patch({ ws: "closed" });
  }

  async refreshMarkets(): Promise<void> {
    if (await this.loadMarkets()) this.evaluate();
  }

  async refreshAccount(): Promise<void> {
    const address = this.cfg.account ?? (this.cfg.demo ? demoAccountAddress : null);
    if (!address || this.busy.account) return;
    this.busy.account = true;
    try {
      const account = await this.info.account(address, this.state.markets);
      this.patch({ account, accountError: null });
    } catch (e) {
      this.patch({ accountError: errMsg(e) });
    } finally {
      this.busy.account = false;
    }
  }

  private async loadMarkets(): Promise<boolean> {
    if (this.busy.markets) return false;
    this.busy.markets = true;
    try {
      const rows = await this.info.markets();
      this.patch({ markets: this.withMids(rows), marketsAt: this.now() });
      return true;
    } catch {
      return false; // keep the last markets; the status bar shows their age
    } finally {
      this.busy.markets = false;
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

  private withMids(rows: MarketRow[]): MarketRow[] {
    if (!this.mids.size) return rows;
    return rows.map((m) => {
      const mid = this.mids.get(m.coin);
      return mid == null || m.midPx === mid ? m : { ...m, midPx: mid };
    });
  }

  private openSocket(): void {
    const sock = this.makeSocket(wsUrl(this.cfg.network));
    this.socket = sock;
    this.patch({ ws: "connecting" });
    sock.onState((s) => this.patch({ ws: s satisfies WsState }));
    sock.subscribe({ type: "allMids" }, (data) => {
      const msg = MidsMessage.safeParse(data);
      if (!msg.success) return;
      let changed = false;
      for (const [coin, px] of Object.entries(msg.data.mids)) {
        const v = Number(px);
        if (Number.isFinite(v) && v > 0 && this.mids.get(coin) !== v) {
          this.mids.set(coin, v);
          changed = true;
        }
      }
      if (changed) this.patch({ markets: this.withMids(this.state.markets) }, true);
    });
  }

  /** Replace state and tell subscribers; `throttle` caps notifications at ~4/s (the state itself always updates). */
  private patch(p: Partial<AppState>, throttle = false): void {
    this.state = { ...this.state, ...p };
    const t = this.now();
    if (throttle && t - this.lastNotify < MIN_NOTIFY_GAP_MS) return;
    this.lastNotify = t;
    for (const fn of this.listeners) safely(fn);
  }
}
