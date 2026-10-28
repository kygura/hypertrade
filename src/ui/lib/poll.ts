import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, NetworkError, makeSequencer } from './api'

// usePoll — the shared polling hook behind useEngine (lib/engine.ts) and
// useIntel (lib/intel.ts). Runs `fetcher` now and every `intervalMs` while
// the tab is visible; polling pauses while `document.visibilityState ===
// 'hidden'` and, on becoming visible, refetches once only if the last
// success is older than the interval (DESIGN-terminal §1.4). Refetches update
// in place: `data` is kept during a failed poll so the surface never flashes
// back to a skeleton (docs/design/README.md §6). Latest-wins: a response
// older than the newest request (or than a deps change / setData) is dropped.
// A deps change resets `data` so the previous key's data is never shown.
// Unmounted callers never poll.

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

/** State at mount and whenever deps change: nothing from the previous key survives. */
export function pollInitial(enabled: boolean): Omit<PollState<never>, 'refetch' | 'setData'> {
  return { data: null, loading: enabled, error: null, offline: null, fetchedAt: null }
}

const isNetworkError = (err: unknown) => err instanceof NetworkError

export function usePoll<T>(fetcher: () => Promise<T>, deps: unknown[], opts: PollOptions = {}): PollState<T> {
  const { intervalMs = null, enabled = true, isOffline = isNetworkError, offlineFallback = 'api unreachable' } = opts
  const [state, setState] = useState<Omit<PollState<T>, 'refetch' | 'setData'>>(pollInitial(enabled))
  const seq = useRef(makeSequencer())
  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher
  const isOfflineRef = useRef(isOffline)
  isOfflineRef.current = isOffline
  const inflight = useRef<number | null>(null)
  const lastOk = useRef<number | null>(null)

  const load = useCallback(async () => {
    if (!enabled || inflight.current != null) return
    const ticket = seq.current.next()
    inflight.current = ticket
    try {
      const data = await fetcherRef.current()
      if (!seq.current.isCurrent(ticket)) return
      lastOk.current = Date.now()
      setState({ data, loading: false, error: null, offline: null, fetchedAt: lastOk.current })
    } catch (err) {
      if (!seq.current.isCurrent(ticket)) return
      if (err instanceof ApiError && err.status === 401) return // redirect in flight
      const off = isOfflineRef.current(err)
      setState((s) => ({
        ...s,
        loading: false,
        error: off ? null : errorMessage(err),
        offline: off ? errorMessage(err, offlineFallback) : null,
      }))
    } finally {
      if (inflight.current === ticket) inflight.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, offlineFallback, ...deps])

  // New key/deps: drop the old response and everything it produced. Keyed on the
  // caller's deps only, so flipping `enabled` keeps the data (no skeleton flash).
  useEffect(() => {
    seq.current.next()
    inflight.current = null
    lastOk.current = null
    setState(pollInitial(enabled))
  }, deps) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!enabled) return
    setState((s) => (s.data == null && !s.loading ? { ...s, loading: true } : s))
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
    seq.current.next()
    lastOk.current = Date.now()
    setState((s) => ({ ...s, data, loading: false, error: null, offline: null, fetchedAt: lastOk.current }))
  }, [])

  return { ...state, refetch, setData }
}
