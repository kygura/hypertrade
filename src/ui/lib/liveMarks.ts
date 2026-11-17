import { useEffect, useRef, useState } from 'react'
import { useHlSubscription } from './hlWs'

// Live desk marks (docs/design/desk-calm.md §1): mids from the shared HL
// websocket, sampled at most every few seconds rather than per tick, so the
// book settles into a new price instead of flickering. The polled mark from
// /desk/portfolio is the fallback whenever no fresh sample exists (socket
// down, coin not in allMids, a testnet venue whose prices differ).

export const SAMPLE_MS = 3_000
/** A live sample older than this no longer beats the polled mark. */
export const LIVE_STALE_MS = 15_000

export interface MarkSample {
  px: number
  /** Epoch ms the sample was taken. */
  at: number
}

/**
 * Throttle, not per tick: every offer updates the latest mid per wanted coin; a snapshot is emitted only when
 * `intervalMs` has passed since the previous one, so it always carries the newest price at emit time.
 */
export class MarkSampler {
  private latest = new Map<string, number>()
  private lastEmit = Number.NEGATIVE_INFINITY

  constructor(
    private readonly intervalMs = SAMPLE_MS,
    private readonly now: () => number = Date.now,
  ) {}

  offer(mids: Record<string, string | number>, coins: readonly string[]): Record<string, MarkSample> | null {
    for (const c of coins) {
      const px = Number(mids[c])
      if (Number.isFinite(px) && px > 0) this.latest.set(c, px)
    }
    const t = this.now()
    if (t - this.lastEmit < this.intervalMs) return null
    const out: Record<string, MarkSample> = {}
    for (const c of coins) {
      const px = this.latest.get(c)
      if (px != null) out[c] = { px, at: t }
    }
    if (Object.keys(out).length === 0) return null
    this.lastEmit = t
    return out
  }
}

/** The mark to show: a fresh live sample, else the polled one. */
export function pickMark(live: MarkSample | undefined, polledPx: number, now: number, staleMs = LIVE_STALE_MS): { px: number; live: boolean } {
  if (live && now - live.at <= staleMs) return { px: live.px, live: true }
  return { px: polledPx, live: false }
}

/** Unrealized P&L at `mark`, before exit fees (what the venue reports at its own mark). */
export const upnlAt = (p: { side: 'long' | 'short'; size: number; entryPx: number }, mark: number): number =>
  (mark - p.entryPx) * p.size * (p.side === 'long' ? 1 : -1)

/** Sampled live mids for `coins` while enabled (one shared allMids subscription). */
export function useLiveMarks(coins: readonly string[], enabled: boolean): Record<string, MarkSample> {
  const [marks, setMarks] = useState<Record<string, MarkSample>>({})
  const sampler = useRef(new MarkSampler())
  const coinsRef = useRef(coins)
  coinsRef.current = coins
  const on = enabled && coins.length > 0
  useHlSubscription<{ mids?: Record<string, string> }>(on ? { type: 'allMids' } : null, (d) => {
    if (!d?.mids) return
    const snap = sampler.current.offer(d.mids, coinsRef.current)
    if (snap) setMarks(snap)
  })
  useEffect(() => {
    if (!on) setMarks({})
  }, [on])
  return marks
}
