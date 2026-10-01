import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChartBar, CandlesResponse } from '../../shared/market'
import type { Timeframe } from '../../shared/timeframes'
import { api, ApiError, NetworkError } from './api'

// Paged chart data for one (coin, timeframe). The first page is the latest
// bars; `loadOlder` fetches the page before the oldest bar held (the server
// backfills it on demand), `refreshHead` re-reads the newest bars after a
// websocket drop, `applyLive` folds a streamed candle into the last bar.

const PAGE = 1500
const HEAD_REFRESH = 300

export interface CandlePages {
  bars: ChartBar[]
  /** Bumped on every replace (not on append/prepend) so the chart can refit. */
  generation: number
  loading: boolean
  loadingOlder: boolean
  hasMore: boolean
  error: string | null
  offline: boolean
  syncError: string | null
  funding: CandlesResponse['funding'] | null
  oi: CandlesResponse['oi'] | null
}

const EMPTY: CandlePages = {
  bars: [],
  generation: 0,
  loading: true,
  loadingOlder: false,
  hasMore: false,
  error: null,
  offline: false,
  syncError: null,
  funding: null,
  oi: null,
}

/** Upserts `incoming` into `bars` by open time; both ascending. */
export function mergeBars(bars: ChartBar[], incoming: ChartBar[]): ChartBar[] {
  if (incoming.length === 0) return bars
  const byT = new Map(bars.map((b) => [b.t, b]))
  for (const b of incoming) byT.set(b.t, b)
  return [...byT.values()].sort((a, b) => a.t - b.t)
}

const path = (coin: string, tf: Timeframe, limit: number, before?: number) =>
  `/candles/${encodeURIComponent(coin)}?tf=${tf}&limit=${limit}${before != null ? `&before=${before}` : ''}`

export function useCandlePages(coin: string, tf: Timeframe) {
  const [state, setState] = useState<CandlePages>(EMPTY)
  const key = `${coin}|${tf}`
  const keyRef = useRef(key)
  keyRef.current = key
  const olderInFlight = useRef(false)

  const loadLatest = useCallback(() => {
    const k = key
    setState((s) => ({ ...EMPTY, generation: s.generation }))
    api
      .get<CandlesResponse>(path(coin, tf, PAGE))
      .then((r) => {
        if (keyRef.current !== k) return
        setState((s) => ({
          ...EMPTY,
          bars: r.bars,
          generation: s.generation + 1,
          loading: false,
          hasMore: r.hasMore,
          syncError: r.error,
          funding: r.funding,
          oi: r.oi,
        }))
      })
      .catch((err: unknown) => {
        if (keyRef.current !== k) return
        if (err instanceof ApiError && err.status === 401) return
        setState((s) => ({
          ...s,
          loading: false,
          offline: err instanceof NetworkError,
          error: err instanceof NetworkError ? null : err instanceof Error ? err.message : String(err),
        }))
      })
  }, [coin, tf, key])

  useEffect(() => {
    loadLatest()
  }, [loadLatest])

  const loadOlder = useCallback(() => {
    const oldest = state.bars[0]
    if (!oldest || !state.hasMore || olderInFlight.current) return
    olderInFlight.current = true
    const k = key
    setState((s) => ({ ...s, loadingOlder: true }))
    api
      .get<CandlesResponse>(path(coin, tf, PAGE, oldest.t))
      .then((r) => {
        if (keyRef.current !== k) return
        setState((s) => ({
          ...s,
          bars: mergeBars(r.bars, s.bars),
          loadingOlder: false,
          hasMore: r.hasMore && r.bars.length > 0,
          syncError: r.error,
          funding: r.funding.from != null ? r.funding : s.funding,
        }))
      })
      .catch((err: unknown) => {
        if (keyRef.current !== k) return
        setState((s) => ({ ...s, loadingOlder: false, syncError: err instanceof Error ? err.message : String(err) }))
      })
      .finally(() => {
        olderInFlight.current = false
      })
  }, [coin, tf, key, state.bars, state.hasMore])

  const refreshHead = useCallback(() => {
    const k = key
    api
      .get<CandlesResponse>(path(coin, tf, HEAD_REFRESH))
      .then((r) => {
        if (keyRef.current !== k) return
        setState((s) => ({ ...s, bars: mergeBars(s.bars, r.bars) }))
      })
      .catch(() => {})
  }, [coin, tf, key])

  /** Folds a streamed candle in; returns true when it opened a new bar. */
  const applyLive = useCallback((bar: Pick<ChartBar, 't' | 'o' | 'h' | 'l' | 'c' | 'v'>) => {
    setState((s) => {
      const last = s.bars[s.bars.length - 1]
      if (!last || bar.t < last.t) return s
      if (bar.t === last.t) {
        const bars = s.bars.slice()
        bars[bars.length - 1] = { ...last, ...bar }
        return { ...s, bars }
      }
      return { ...s, bars: [...s.bars, { ...bar, src: 'hl', f: null, p: null, oi: null }] }
    })
  }, [])

  return { ...state, reload: loadLatest, loadOlder, refreshHead, applyLive }
}
