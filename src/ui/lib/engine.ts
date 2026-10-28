import { api, ApiError, NetworkError, parseWith } from './api'
import { errorMessage, usePoll, type PollState } from './poll'
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

const base = '/engine'

export const engine = {
  listManifests: async (): Promise<Manifest[]> =>
    parseWith(ManifestsResponseSchema, 'engine')(await api.get(`${base}/manifests`)).manifests,

  listStrategies: async (): Promise<StrategyStatus[]> =>
    parseWith(StrategiesResponseSchema, 'engine')(await api.get(`${base}/configs`)).strategies,

  getStrategy: async (id: string): Promise<StrategyStatus> =>
    parseWith(StrategyStatusSchema, 'engine')(await api.get(`${base}/configs/${encodeURIComponent(id)}`)),

  putConfig: async (id: string, config: StrategyConfig): Promise<StrategyStatus> =>
    parseWith(StrategyStatusSchema, 'engine')(await api.put(`${base}/configs/${encodeURIComponent(id)}`, config)),

  run: async (id: string, dryRun = true): Promise<DecisionRecord> =>
    parseWith(DecisionRecordSchema, 'engine')(await api.post(`${base}/configs/${encodeURIComponent(id)}/run`, { dry_run: dryRun })),

  listDecisions: async (opts: { limit?: number; strategy?: string } = {}): Promise<DecisionRecord[]> => {
    const q = new URLSearchParams()
    q.set('limit', String(opts.limit ?? 50))
    if (opts.strategy) q.set('strategy', opts.strategy)
    return parseWith(DecisionsResponseSchema, 'engine')(await api.get(`${base}/decisions?${q.toString()}`)).decisions
  },

  getDecision: async (id: string): Promise<DecisionRecord> =>
    parseWith(DecisionRecordSchema, 'engine')(await api.get(`${base}/decisions/${encodeURIComponent(id)}`)),

  approveIntent: async (decisionId: string, intentId: string): Promise<DecisionRecord> =>
    parseWith(DecisionRecordSchema, 'engine')(await api.post(`${base}/decisions/${encodeURIComponent(decisionId)}/intents/${encodeURIComponent(intentId)}/approve`),
    ),

  rejectIntent: async (decisionId: string, intentId: string): Promise<DecisionRecord> =>
    parseWith(DecisionRecordSchema, 'engine')(await api.post(`${base}/decisions/${encodeURIComponent(decisionId)}/intents/${encodeURIComponent(intentId)}/reject`),
    ),

  listVenues: async (): Promise<VenueStatus[]> =>
    parseWith(VenuesResponseSchema, 'engine')(await api.get(`${base}/venues`)).venues,

  getGovernor: async (): Promise<GovernorSettings> => parseWith(GovernorSettingsSchema, 'engine')(await api.get(`${base}/governor`)),

  putGovernor: async (settings: GovernorSettings): Promise<GovernorSettings> =>
    parseWith(GovernorSettingsSchema, 'engine')(await api.put(`${base}/governor`, settings)),

  kill: async (): Promise<GovernorSettings> => parseWith(GovernorSettingsSchema, 'engine')(await api.post(`${base}/kill`)),
}

/** True for the proxy's own "engine not configured" (503) / "engine unreachable" (502) answers. */
export function isEngineOffline(err: unknown): boolean {
  if (err instanceof NetworkError) return true
  return err instanceof ApiError && (err.status === 502 || err.status === 503)
}

export { errorMessage }

export type EngineState<T> = PollState<T>

export const ENGINE_POLL_MS = 5_000

// useEngine — usePoll (lib/poll.ts) with the engine defaults: 5 s cadence,
// and the proxy's 502/503 answers read as offline. Pass `enabled=false` to
// skip (e.g. missing route param).
export function useEngine<T>(
  fetcher: () => Promise<T>,
  deps: unknown[],
  opts: { intervalMs?: number | null; enabled?: boolean } = {},
): EngineState<T> {
  const { intervalMs = ENGINE_POLL_MS, enabled = true } = opts
  return usePoll(fetcher, deps, { intervalMs, enabled, isOffline: isEngineOffline, offlineFallback: 'engine unreachable' })
}

