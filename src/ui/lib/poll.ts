import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, NetworkError } from './api'

// usePoll — the shared polling hook behind useEngine (lib/engine.ts) and
// useIntel (lib/intel.ts). Runs `fetcher` now and every `intervalMs` while
// the tab is visible; polling pauses while `document.visibilityState ===
// 'hidden'` and, on becoming visible, refetches once only if the last
// success is older than the interval (DESIGN-terminal §1.4). Refetches update
// in place: `data` is kept during a failed poll so the surface never flashes
// back to a skeleton (docs/design/README.md §6). Unmounted callers never poll.

export function errorMessage(err: unknown, fallback = 'request failed'): string {
  return err instanceof Error && err.message ? err.message : fallback
}

export interface PollState<T> {
  data: T | null
  loading: boolean
  /** Server responded with a failure (verbatim message) — docs/design/README.md §6 ErrorBlock. */
  error: string | null
  /** No usable response (network, or what `isOffline` says) — OfflineBlock. Message is the verbatim reason. */
  offline: string | null
  /** Last successful fetch, for the age stamp. */
  fetchedAt: number | null
  refetch: () => void
  /** Replace the cached data locally (after a PUT/POST returned the new record). */
  setData: (data: T) => void
}

export interface PollOptions {
  /** Poll cadence; null = fetch on mount (and refetch) only. */
  intervalMs?: number | null
  /** false skips fetching entirely (e.g. a missing route param). */
  enabled?: boolean
  /** Which failures count as "offline" rather than an error. Default: no HTTP response at all. */
  isOffline?: (err: unknown) => boolean
  /** Offline text when the error carries no message. */
  offlineFallback?: string
}

const isNetworkError = (err: unknown) => err instanceof NetworkError

export function usePoll<T>(fetcher: () => Promise<T>, deps: unknown[], opts: PollOptions = {}): PollState<T> {
  const { intervalMs = null, enabled = true, isOffline = isNetworkError, offlineFallback = 'api unreachable' } = opts
  const [state, setState] = useState<Omit<PollState<T>, 'refetch' | 'setData'>>({
    data: null,
    loading: enabled,
    error: null,
    offline: null,
    fetchedAt: null,
  })
  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher
  const isOfflineRef = useRef(isOffline)
  isOfflineRef.current = isOffline
  const inflight = useRef(false)
  const lastOk = useRef<number | null>(null)

  const load = useCallback(async () => {
    if (!enabled || inflight.current) return
    inflight.current = true
    try {
      const data = await fetcherRef.current()
      lastOk.current = Date.now()
      setState({ data, loading: false, error: null, offline: null, fetchedAt: lastOk.current })
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return // redirect in flight
      const off = isOfflineRef.current(err)
      setState((s) => ({
        ...s,
        loading: false,
        error: off ? null : errorMessage(err),
        offline: off ? errorMessage(err, offlineFallback) : null,
      }))
    } finally {
      inflight.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, offlineFallback, ...deps])

  useEffect(() => {
    if (!enabled) return
    setState((s) => ({ ...s, loading: s.data == null }))
    void load()
    if (intervalMs == null) return

    let timer: ReturnType<typeof setInterval> | null = null
    const start = () => {
      if (timer == null) timer = setInterval(() => void load(), intervalMs)
    }
    const stop = () => {
      if (timer != null) clearInterval(timer)
      timer = null
    }
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') stop()
      else {
        if (lastOk.current == null || Date.now() - lastOk.current >= intervalMs) void load()
        start()
      }
    }
    if (document.visibilityState !== 'hidden') start()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [load, enabled, intervalMs])

  const refetch = useCallback(() => {
    setState((s) => ({ ...s, loading: s.data == null, error: null, offline: null }))
    void load()
  }, [load])

  const setData = useCallback((data: T) => {
    lastOk.current = Date.now()
    setState((s) => ({ ...s, data, loading: false, error: null, offline: null, fetchedAt: lastOk.current }))
  }, [])

  return { ...state, refetch, setData }
}
