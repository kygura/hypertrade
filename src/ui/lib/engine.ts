import { useCallback, useEffect, useRef, useState } from 'react'
import type { z } from 'zod'
import { api, ApiError, NetworkError } from './api'
import {
  DecisionRecordSchema,
  DecisionsResponseSchema,
  GovernorSettingsSchema,
  ManifestsResponseSchema,
  StrategiesResponseSchema,
  StrategyStatusSchema,
  VenuesResponseSchema,
  type DecisionRecord,
  type GovernorSettings,
  type Manifest,
  type StrategyConfig,
  type StrategyStatus,
  type VenueStatus,
} from '../../shared/strategy-protocol'

// Typed client over /api/engine/* (hyperion/docs/jev/PROTOCOL.md). Every
// response is parsed with its zod schema so a drifting core fails loudly
// here, not deep inside a render. WS is not proxied in this scaffold; the
// pages poll through useEngine (5s, paused while the tab is hidden).

function parse<S extends z.ZodTypeAny>(schema: S, body: unknown): z.infer<S> {
  const r = schema.safeParse(body)
  if (!r.success) {
    const issue = r.error.issues[0]
    throw new Error(`engine response mismatch: ${issue?.path.join('.') || '<root>'} ${issue?.message ?? ''}`.trim())
  }
  return r.data
}

const base = '/engine'

export const engine = {
  listManifests: async (): Promise<Manifest[]> =>
    parse(ManifestsResponseSchema, await api.get(`${base}/manifests`)).manifests,

  listStrategies: async (): Promise<StrategyStatus[]> =>
    parse(StrategiesResponseSchema, await api.get(`${base}/configs`)).strategies,

  getStrategy: async (id: string): Promise<StrategyStatus> =>
    parse(StrategyStatusSchema, await api.get(`${base}/configs/${encodeURIComponent(id)}`)),

  putConfig: async (id: string, config: StrategyConfig): Promise<StrategyStatus> =>
    parse(StrategyStatusSchema, await api.put(`${base}/configs/${encodeURIComponent(id)}`, config)),

  run: async (id: string, dryRun = true): Promise<DecisionRecord> =>
    parse(DecisionRecordSchema, await api.post(`${base}/configs/${encodeURIComponent(id)}/run`, { dry_run: dryRun })),

  listDecisions: async (opts: { limit?: number; strategy?: string } = {}): Promise<DecisionRecord[]> => {
    const q = new URLSearchParams()
    q.set('limit', String(opts.limit ?? 50))
    if (opts.strategy) q.set('strategy', opts.strategy)
    return parse(DecisionsResponseSchema, await api.get(`${base}/decisions?${q.toString()}`)).decisions
  },

  getDecision: async (id: string): Promise<DecisionRecord> =>
    parse(DecisionRecordSchema, await api.get(`${base}/decisions/${encodeURIComponent(id)}`)),

  approveIntent: async (decisionId: string, intentId: string): Promise<DecisionRecord> =>
    parse(
      DecisionRecordSchema,
      await api.post(`${base}/decisions/${encodeURIComponent(decisionId)}/intents/${encodeURIComponent(intentId)}/approve`),
    ),

  rejectIntent: async (decisionId: string, intentId: string): Promise<DecisionRecord> =>
    parse(
      DecisionRecordSchema,
      await api.post(`${base}/decisions/${encodeURIComponent(decisionId)}/intents/${encodeURIComponent(intentId)}/reject`),
    ),

  listVenues: async (): Promise<VenueStatus[]> =>
    parse(VenuesResponseSchema, await api.get(`${base}/venues`)).venues,

  getGovernor: async (): Promise<GovernorSettings> => parse(GovernorSettingsSchema, await api.get(`${base}/governor`)),

  putGovernor: async (settings: GovernorSettings): Promise<GovernorSettings> =>
    parse(GovernorSettingsSchema, await api.put(`${base}/governor`, settings)),

  kill: async (): Promise<GovernorSettings> => parse(GovernorSettingsSchema, await api.post(`${base}/kill`)),
}

/** True for the proxy's own "engine not configured" (503) / "engine unreachable" (502) answers. */
export function isEngineOffline(err: unknown): boolean {
  if (err instanceof NetworkError) return true
  return err instanceof ApiError && (err.status === 502 || err.status === 503)
}

export function errorMessage(err: unknown, fallback = 'request failed'): string {
  return err instanceof Error && err.message ? err.message : fallback
}

export interface EngineState<T> {
  data: T | null
  loading: boolean
  /** Server responded with a failure (verbatim message) — DESIGN.md §6 ErrorBlock. */
  error: string | null
  /** Proxy says the engine is unreachable/not configured — OfflineBlock. Message is the verbatim reason. */
  offline: string | null
  /** Last successful fetch, for the age stamp. */
  fetchedAt: number | null
  refetch: () => void
  /** Replace the cached data locally (after a PUT/POST returned the new record). */
  setData: (data: T) => void
}

export const ENGINE_POLL_MS = 5_000

// useEngine — run `fetcher` now and every `intervalMs` while the tab is
// visible. Refetches update in place: `data` is kept during a failed poll so
// the surface never flashes back to a skeleton (§6). Pass `enabled=false` to
// skip (e.g. missing route param).
export function useEngine<T>(
  fetcher: () => Promise<T>,
  deps: unknown[],
  opts: { intervalMs?: number | null; enabled?: boolean } = {},
): EngineState<T> {
  const { intervalMs = ENGINE_POLL_MS, enabled = true } = opts
  const [state, setState] = useState<Omit<EngineState<T>, 'refetch' | 'setData'>>({
    data: null,
    loading: enabled,
    error: null,
    offline: null,
    fetchedAt: null,
  })
  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher
  const inflight = useRef(false)

  const load = useCallback(async () => {
    if (!enabled || inflight.current) return
    inflight.current = true
    try {
      const data = await fetcherRef.current()
      setState({ data, loading: false, error: null, offline: null, fetchedAt: Date.now() })
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return // redirect in flight
      setState((s) => ({
        ...s,
        loading: false,
        error: isEngineOffline(err) ? null : errorMessage(err),
        offline: isEngineOffline(err) ? errorMessage(err, 'engine unreachable') : null,
      }))
    } finally {
      inflight.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ...deps])

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
        void load()
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
    setState((s) => ({ ...s, data, loading: false, error: null, offline: null, fetchedAt: Date.now() }))
  }, [])

  return { ...state, refetch, setData }
}
