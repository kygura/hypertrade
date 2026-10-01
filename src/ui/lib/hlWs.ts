import { useEffect, useRef } from 'react'
import { HL_WS } from '../../shared/hl-client'

// Hyperliquid public websocket, straight from the browser (no auth, no
// server hop). One shared connection; subscriptions are ref-counted so any
// number of components can watch the same feed. HL drops connections idle
// for 60s, so we ping every 50s, and reconnect with backoff after any drop,
// replaying every live subscription. Reconnect listeners let a chart refetch
// the bars it missed while the socket was down.

export type HlSub = { type: 'candle'; coin: string; interval: string } | { type: 'activeAssetCtx'; coin: string }

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

type Handler = (data: unknown) => void

const PING_MS = 50_000
const IDLE_CLOSE_MS = 30_000
const MAX_BACKOFF_MS = 30_000

const keyOf = (s: HlSub) => (s.type === 'candle' ? `candle|${s.coin}|${s.interval}` : `activeAssetCtx|${s.coin}`)

class HlSocket {
  private ws: WebSocket | null = null
  private subs = new Map<string, { sub: HlSub; handlers: Set<Handler> }>()
  private reconnectListeners = new Set<() => void>()
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private backoff = 1_000
  private everOpened = false

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
      if (this.subs.size === 0) this.idleTimer = setTimeout(() => this.close(), IDLE_CLOSE_MS)
    }
  }

  onReconnect(cb: () => void): () => void {
    this.reconnectListeners.add(cb)
    return () => this.reconnectListeners.delete(cb)
  }

  private send(msg: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg))
  }

  private ensureOpen() {
    if (this.ws || this.retryTimer || typeof WebSocket === 'undefined') return
    const ws = new WebSocket(HL_WS)
    this.ws = ws
    ws.onopen = () => {
      this.backoff = 1_000
      for (const { sub } of this.subs.values()) this.send({ method: 'subscribe', subscription: sub })
      this.pingTimer = setInterval(() => this.send({ method: 'ping' }), PING_MS)
      if (this.everOpened) this.reconnectListeners.forEach((l) => l())
      this.everOpened = true
    }
    ws.onmessage = (ev) => {
      let msg: { channel?: string; data?: unknown }
      try {
        msg = JSON.parse(String(ev.data))
      } catch {
        return
      }
      let key: string | null = null
      if (msg.channel === 'candle') {
        const c = msg.data as WsCandle
        key = `candle|${c.s}|${c.i}`
      } else if (msg.channel === 'activeAssetCtx') {
        key = `activeAssetCtx|${(msg.data as WsAssetCtx).coin}`
      }
      if (key) this.subs.get(key)?.handlers.forEach((h) => h(msg.data))
    }
    ws.onclose = () => {
      this.teardown()
      if (this.subs.size === 0) return
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
    }
  }
}

export const hlSocket = new HlSocket()

/** Subscribe while mounted; `sub` null pauses. The handler may change freely. */
export function useHlSubscription<T>(sub: HlSub | null, handler: (data: T) => void) {
  const ref = useRef(handler)
  ref.current = handler
  const key = sub ? keyOf(sub) : null
  useEffect(() => {
    if (!sub) return
    return hlSocket.subscribe(sub, (d) => ref.current(d as T))
    // key captures sub's identity
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
}

/** Called after the socket comes back from a drop. */
export function useHlReconnect(cb: () => void) {
  const ref = useRef(cb)
  ref.current = cb
  useEffect(() => hlSocket.onReconnect(() => ref.current()), [])
}
