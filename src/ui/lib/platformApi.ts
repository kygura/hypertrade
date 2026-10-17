import { api, ApiError, NetworkError } from './api'
import {
  FeedResponseSchema,
  LedgerStatsResponseSchema,
  LiqBoardResponseSchema,
  LIQMAP_BUCKET_BPS,
  LIQMAP_PANEL_RANGE,
  LiqMapHistoryResponseSchema,
  LiqMapResponseSchema,
  OpportunityDetailSchema,
  PlatformHealthResponseSchema,
  type FeedResponse,
  type LedgerStats,
  type LiqBoardResponse,
  type LiqMap,
  type LiqMapHistory,
  type OpportunityDetail,
  type PlatformHealth,
} from '../../shared/platform'

// Typed /api/platform client (SPEC.md § Platform P2). Every response is parsed
// with its src/shared/platform.ts schema, so a contract drift fails loudly as
// an ErrorBlock instead of rendering garbage. 401 → /login lives in api.ts.

const P = '/platform'

/** No response, or the server answered 503 platform_offline (runtime absent): render OfflineBlock. */
export const isPlatformOffline = (err: unknown) => err instanceof NetworkError || (err instanceof ApiError && err.status === 503 && err.message === 'platform_offline')
/** usePoll options every platform poller shares (offline = OfflineBlock, not ErrorBlock). */
export const PLATFORM_POLL = { isOffline: isPlatformOffline, offlineFallback: 'platform API unreachable' } as const
const nullOn = async <T>(p: Promise<T>, status: number, code?: string): Promise<T | null> => {
  try {
    return await p
  } catch (e) {
    if (e instanceof ApiError && e.status === status && (code == null || e.message === code)) return null
    throw e
  }
}
/** Human text for an action failure: 422 governor reasons, 409 stale_feed message, else the error verbatim. */
export function actionFailure(err: unknown): { stale: string | null; message: string } {
  const body = err instanceof ApiError && err.body && typeof err.body === 'object' ? (err.body as { error?: string; message?: string; reasons?: string[] }) : null
  if (body?.error === 'stale_feed') return { stale: body.message ?? 'stale_feed', message: body.message ?? 'stale_feed' }
  if (body?.error === 'governor_blocked' && Array.isArray(body.reasons)) return { stale: null, message: `governor_blocked: ${body.reasons.join('; ')}` }
  return { stale: null, message: err instanceof Error && err.message ? err.message : 'request failed' }
}
const id = (s: string) => encodeURIComponent(s)

export const platform = {
  feed: async (): Promise<FeedResponse> => FeedResponseSchema.parse(await api.get(`${P}/opportunities?limit=100`)),
  /** null = 404 (bad `?id`). */
  detail: async (oppId: string): Promise<OpportunityDetail | null> => {
    const r = await nullOn(api.get(`${P}/opportunities/${id(oppId)}`), 404)
    return r == null ? null : OpportunityDetailSchema.parse(r)
  },
  /** null = 503 no_mark (no live mid and no scan snapshot yet). */
  liqmap: async (coin: string): Promise<LiqMap | null> => {
    const r = await nullOn(api.get(`${P}/liqmap?coin=${id(coin)}&range=${LIQMAP_PANEL_RANGE}&bucketBps=${LIQMAP_BUCKET_BPS}`), 503, 'no_mark')
    return r == null ? null : LiqMapResponseSchema.parse(r)
  },
  board: async (): Promise<LiqBoardResponse> => LiqBoardResponseSchema.parse(await api.get(`${P}/liqmap/board`)),
  /** The largest-n group for one filter (setupKind plus regime or tier); null with no outcomes. */
  stats: async (q: { setupKind: string; regime?: string; tier?: number }): Promise<LedgerStats | null> => {
    const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]))
    const { stats } = LedgerStatsResponseSchema.parse(await api.get(`${P}/ledger/stats?${qs}`))
    return stats.reduce<LedgerStats | null>((a, b) => (a == null || b.n > a.n ? b : a), null)
  },
  history: async (coin: string, hours: number): Promise<LiqMapHistory> =>
    LiqMapHistoryResponseSchema.parse(await api.get(`${P}/liqmap/history?coin=${id(coin)}&hours=${hours}`)),
  /**
   * Public `/api/health`. null when the platform runtime adds no fields (API-only / Vercel) or the
   * server sent the redacted no-session shape `{ok, ts, loops:[{name, ok}], ws}` (no `crawler`): gray items.
   */
  health: async (): Promise<PlatformHealth | null> => {
    const r = await api.get<Record<string, unknown>>('/health')
    return r && 'loops' in r && 'crawler' in r ? PlatformHealthResponseSchema.parse(r) : null
  },
  approve: (oppId: string) => api.post<unknown>(`${P}/opportunities/${id(oppId)}/approve`),
  reject: (oppId: string, reason: string) => api.post<unknown>(`${P}/opportunities/${id(oppId)}/reject`, { reason }),
  snooze: (oppId: string, minutes: number) => api.post<unknown>(`${P}/opportunities/${id(oppId)}/snooze`, { minutes }),
  research: (oppId: string) => api.post<unknown>(`${P}/opportunities/${id(oppId)}/research`),
}
