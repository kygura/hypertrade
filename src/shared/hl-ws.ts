import { HL_WS } from './hl-client.js'

// Hyperliquid public websocket client, isomorphic (global WebSocket: browser
// and Bun). One connection; subscriptions are ref-counted so any number of
// consumers can watch a feed. HL drops connections idle for 60s, so we ping
// every 50s, and reconnect with backoff after any drop, replaying every live
// subscription. HL limits: <=1000 subscriptions per connection and 30 new
// connections/min; backoff (1s doubling to 30s) keeps one process far below
// the latter, and callers stay below the former (the server needs ~250).

export type HlSub =
  | { type: 'candle'; coin: string; interval: string }
  | { type: 'activeAssetCtx'; coin: string }
  | { type: 'trades'; coin: string }
  | { type: 'allMids' }

/** WS candle: HL sends numbers as strings. */
export interface WsCandle {
  t: number
  T: number
  s: string
  i: string
  o: string | number
  h: string | number
  l: string | number
  c: string | number
  v: string | number
}

export interface WsAssetCtx {
  coin: string
  ctx: {
    funding: string
    openInterest: string
    oraclePx: string
    markPx: string
    midPx?: string | null
    premium?: string | null
    dayNtlVlm: string
    prevDayPx: string
    impactPxs?: string[] | null
  }
}

export type HlSocketState = 'connecting' | 'open' | 'closed'
type Handler = (data: unknown) => void

const PING_MS = 50_000
const IDLE_CLOSE_MS = 30_000
const MAX_BACKOFF_MS = 30_000

export const keyOf = (s: HlSub) => {
  switch (s.type) {
    case 'candle': return `candle|${s.coin}|${s.interval}`
    case 'allMids': return 'allMids'
    default: return `${s.type}|${s.coin}`
  }
}

/** Routing key of an incoming message, or null when it carries no routable subscription. */
function msgKey(msg: { channel?: string; data?: unknown }): string | null {
  const d = msg.data as any
  switch (msg.channel) {
    case 'candle': return typeof d?.s === 'string' ? `candle|${d.s}|${d.i}` : null
    case 'activeAssetCtx': return typeof d?.coin === 'string' ? `activeAssetCtx|${d.coin}` : null
    case 'trades': return Array.isArray(d) && typeof d[0]?.coin === 'string' ? `trades|${d[0].coin}` : null
    case 'allMids': return 'allMids'
    default: return null
  }
}

export interface HlSocketOptions {
  url?: string
  /** Close after this long with no subscribers (browser sharing). Default 30s; 0 = never. */
  idleCloseMs?: number
  /** Force a reconnect when no message arrived for this long (server: allMids ticks every ~1s). 0 = off. */
  staleMs?: number
  /** Test seam. */
  create?: (url: string) => WebSocket
}

export class HlSocket {
  private ws: WebSocket | null = null
  private subs = new Map<string, { sub: HlSub; handlers: Set<Handler> }>()
  private reconnectListeners = new Set<() => void>()
  private stateListeners = new Set<(s: HlSocketState) => void>()
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private backoff = 1_000
  private everOpened = false
  private stopped = false
  private _state: HlSocketState = 'closed'
  /** Epoch ms of the last message received on the current or last connection (0 = none yet). */
  lastMessageAt = 0

  constructor(private readonly opts: HlSocketOptions = {}) {}

  get state() {
    return this._state
  }
  get subscriptionCount() {
    return this.subs.size
  }

  subscribe(sub: HlSub, handler: Handler): () => void {
    const key = keyOf(sub)
    let entry = this.subs.get(key)
    if (!entry) {
      entry = { sub, handlers: new Set() }
      this.subs.set(key, entry)
      this.send({ method: 'subscribe', subscription: sub })
    }
    entry.handlers.add(handler)
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.ensureOpen()
    return () => {
      const e = this.subs.get(key)
      if (!e) return
      e.handlers.delete(handler)
      if (e.handlers.size === 0) {
        this.subs.delete(key)
        this.send({ method: 'unsubscribe', subscription: sub })
      }
      const idle = this.opts.idleCloseMs ?? IDLE_CLOSE_MS
      if (this.subs.size === 0 && idle > 0) this.idleTimer = setTimeout(() => this.close(), idle)
    }
  }

  onReconnect(cb: () => void): () => void {
    this.reconnectListeners.add(cb)
    return () => this.reconnectListeners.delete(cb)
  }

  onState(cb: (s: HlSocketState) => void): () => void {
    this.stateListeners.add(cb)
    return () => this.stateListeners.delete(cb)
  }

  /** Close for good: no reconnect. */
  stop() {
    this.stopped = true
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.close()
  }

  private setState(s: HlSocketState) {
    if (s === this._state) return
    this._state = s
    this.stateListeners.forEach((l) => l(s))
  }

  private send(msg: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg))
  }

  private ensureOpen() {
    if (this.ws || this.retryTimer || this.stopped || typeof WebSocket === 'undefined') return
    const url = this.opts.url ?? HL_WS
    const ws = this.opts.create ? this.opts.create(url) : new WebSocket(url)
    this.ws = ws
    this.setState('connecting')
    ws.onopen = () => {
      this.backoff = 1_000
      this.lastMessageAt = Date.now()
      for (const { sub } of this.subs.values()) this.send({ method: 'subscribe', subscription: sub })
      const stale = this.opts.staleMs ?? 0
      this.pingTimer = setInterval(() => {
        if (stale > 0 && Date.now() - this.lastMessageAt > stale) return ws.close()
        this.send({ method: 'ping' })
      }, stale > 0 ? Math.min(PING_MS, stale / 2) : PING_MS)
      this.setState('open')
      if (this.everOpened) this.reconnectListeners.forEach((l) => l())
      this.everOpened = true
    }
    ws.onmessage = (ev) => {
      this.lastMessageAt = Date.now()
      let msg: { channel?: string; data?: unknown }
      try {
        msg = JSON.parse(String(ev.data))
      } catch {
        return
      }
      const key = msgKey(msg)
      if (key) this.subs.get(key)?.handlers.forEach((h) => h(msg.data))
    }
    ws.onclose = () => {
      this.teardown()
      this.setState('closed')
      if (this.subs.size === 0 || this.stopped) return
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null
        this.ensureOpen()
      }, this.backoff)
      this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS)
    }
    ws.onerror = () => ws.close()
  }

  private teardown() {
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.pingTimer = null
    this.ws = null
  }

  private close() {
    const ws = this.ws
    this.teardown()
    if (ws) {
      ws.onclose = null
      ws.close()
      this.setState('closed')
    }
  }
}
