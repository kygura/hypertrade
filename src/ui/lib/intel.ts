import { z } from 'zod'
import { api, ApiError } from './api'
import { usePoll, type PollState } from './poll'
import {
  AlertsResponseSchema,
  AssetDetailResponseSchema,
  BriefLatestResponseSchema,
  BriefSchema,
  CatalystsResponseSchema,
  EdgeSchema,
  EventsResponseSchema,
  FeedbackReportSchema,
  FlowsResponseSchema,
  GraphResponseSchema,
  HeatmapResponseSchema,
  JournalReportSchema,
  JournalResponseSchema,
  JournalTagResponseSchema,
  ManualPositionSchema,
  OrderConfirmResponseSchema,
  OrderPreviewSchema,
  PositionsResponseSchema,
  QueryParseResponseSchema,
  QueryResultSchema,
  ReviewsResponseSchema,
  ThesesResponseSchema,
  ThesisSchema,
  TradeNoteSchema,
  WatchChangesResponseSchema,
  WatchesResponseSchema,
  WatchlistResponseSchema,
  WatchSchema,
  type Alert,
  type AlertFeedbackInput,
  type AlertKind,
  type AssetDetailResponse,
  type Brief,
  type Catalyst,
  type Edge,
  type EdgeKey,
  type EventType,
  type FeedbackReport,
  type FlowFlag,
  type GraphResponse,
  type HeatmapResponse,
  type HeatmapWindow,
  type IntelEvent,
  type JournalReport,
  type JournalResponse,
  type ManualCatalystInput,
  type ManualPosition,
  type ManualPositionInput,
  type OrderConfirmResponse,
  type OrderIntent,
  type OrderPreview,
  type OrderPreviewRequest,
  type PositionsResponse,
  type QueryParseResponse,
  type QueryResult,
  type Review,
  type ScreenerDslInput,
  type Thesis,
  type TradeNote,
  type UserEdgeInput,
  type Watch,
  type WatchChange,
  type WatchInput,
  type WatchlistPut,
  type WatchlistResponse,
} from '../../shared/intel'

// Typed client over /api/intel/* (SPEC.md § Intel I2) for the Terminal family
// (DESIGN-terminal.md). Every response is parsed with its shared zod schema
// (src/shared/intel.ts) so a drifting server fails loudly here, not deep
// inside a render. Writes whose response SPEC I2 does not pin resolve to void:
// the caller refetches ("on mount + after a write", DESIGN-terminal §1.4).

function parse<S extends z.ZodTypeAny>(schema: S, body: unknown): z.infer<S> {
  const r = schema.safeParse(body)
  if (!r.success) {
    const issue = r.error.issues[0]
    throw new Error(`intel response mismatch: ${issue?.path.join('.') || '<root>'} ${issue?.message ?? ''}`.trim())
  }
  return r.data
}

/** `GET /journal/report/latest` mirrors `GET /brief/latest`: `{report: JournalReport | null}`. */
const JournalReportLatestSchema = z.object({ report: JournalReportSchema.nullable() })

/** `GET /feedback/report/latest`: `{report: FeedbackReport | null}` (SPEC I0.12). */
const FeedbackReportLatestSchema = z.object({ report: FeedbackReportSchema.nullable() })

/** `POST /journal/tag` answers `{tagged, failed, error?}` (routes/intel/journal.ts); `error` is the first model failure, verbatim. */
const JournalTagResultSchema = JournalTagResponseSchema.extend({ failed: z.number().int().default(0), error: z.string().optional() })
export type JournalTagResult = z.infer<typeof JournalTagResultSchema>

const base = '/intel'
const enc = encodeURIComponent

function qs(params: Record<string, string | number | undefined>): string {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, String(v))
  const s = q.toString()
  return s ? `?${s}` : ''
}

const done = () => undefined

export const intel = {
  // ── positions + watchlist (I0.2) ──
  positions: async (): Promise<PositionsResponse> => parse(PositionsResponseSchema, await api.get(`${base}/positions`)),
  addPosition: async (input: ManualPositionInput): Promise<ManualPosition> =>
    parse(ManualPositionSchema, await api.post(`${base}/positions`, input)),
  updatePosition: async (id: string, input: ManualPositionInput): Promise<ManualPosition> =>
    parse(ManualPositionSchema, await api.put(`${base}/positions/${enc(id)}`, input)),
  deletePosition: (id: string): Promise<void> => api.del(`${base}/positions/${enc(id)}`).then(done),
  watchlist: async (): Promise<WatchlistResponse> => parse(WatchlistResponseSchema, await api.get(`${base}/watchlist`)),
  /** Full replace (DESIGN-terminal §3.7: every write is a full PUT). */
  putWatchlist: async (items: WatchlistPut['items']): Promise<WatchlistResponse> =>
    parse(WatchlistResponseSchema, await api.put(`${base}/watchlist`, { items })),

  // ── brief + reviews (I0.14) ──
  /** Logs a review. Only a real open calls this (DESIGN-terminal §1.5); `deeplink` for `/?review=1`. */
  brief: async (via: Review['via'] = 'ui'): Promise<Brief> => parse(BriefSchema, await api.post(`${base}/brief`, { via })),
  latestBrief: async (): Promise<Brief | null> => parse(BriefLatestResponseSchema, await api.get(`${base}/brief/latest`)).brief,
  reviews: async (limit?: number): Promise<Review[]> =>
    parse(ReviewsResponseSchema, await api.get(`${base}/reviews${qs({ limit })}`)).reviews,

  // ── alerts, events, catalysts (I0.9–I0.13) ──
  alerts: async (q: { since?: string; kind?: AlertKind } = {}): Promise<Alert[]> =>
    parse(AlertsResponseSchema, await api.get(`${base}/alerts${qs(q)}`)).alerts,
  alertFeedback: (id: string, vote: AlertFeedbackInput['vote']): Promise<void> =>
    api.post(`${base}/alerts/${enc(id)}/feedback`, { vote } satisfies AlertFeedbackInput).then(done),
  events: async (q: { since?: string; type?: EventType } = {}): Promise<IntelEvent[]> =>
    parse(EventsResponseSchema, await api.get(`${base}/events${qs(q)}`)).events,
  catalysts: async (days = 14): Promise<Catalyst[]> =>
    parse(CatalystsResponseSchema, await api.get(`${base}/catalysts${qs({ days })}`)).catalysts,
  addCatalyst: (input: ManualCatalystInput): Promise<void> => api.post(`${base}/catalysts`, input).then(done),
  /** Manual catalysts only; `id` is the catalyst's `eventId`. */
  deleteCatalyst: (id: string): Promise<void> => api.del(`${base}/catalysts/${enc(id)}`).then(done),
  /** Weekly feedback report (worst buckets first), or null before the first one. */
  feedbackReport: async (): Promise<FeedbackReport | null> =>
    parse(FeedbackReportLatestSchema, await api.get(`${base}/feedback/report/latest`)).report,

  // ── exposure graph (I0.8) ──
  graph: async (asset: string): Promise<GraphResponse> => parse(GraphResponseSchema, await api.get(`${base}/graph${qs({ asset })}`)),
  addEdge: async (input: UserEdgeInput): Promise<Edge> => parse(EdgeSchema, await api.post(`${base}/graph/edges`, input)),
  /** User edges only; the edge key travels in the DELETE body. */
  deleteEdge: (key: EdgeKey): Promise<void> => api.del(`${base}/graph/edges`, key).then(done),

  // ── journal (I0.15) ──
  journal: async (days = 30): Promise<JournalResponse> => parse(JournalResponseSchema, await api.get(`${base}/journal${qs({ days })}`)),
  saveNote: async (tradeId: string, note: string): Promise<TradeNote> =>
    parse(TradeNoteSchema, await api.put(`${base}/journal/${enc(tradeId)}/note`, { note })),
  /** Tags untagged trades in the window (≤ 25 per call). 503 = no LLM configured. */
  tagUntagged: async (days?: number): Promise<JournalTagResult> =>
    parse(JournalTagResultSchema, await api.post(`${base}/journal/tag`, days == null ? {} : { days })),
  latestReport: async (): Promise<JournalReport | null> =>
    parse(JournalReportLatestSchema, await api.get(`${base}/journal/report/latest`)).report,
  generateReport: async (): Promise<JournalReport> => parse(JournalReportSchema, await api.post(`${base}/journal/report`)),

  // ── theses (I0.16) ──
  theses: async (): Promise<Thesis[]> => parse(ThesesResponseSchema, await api.get(`${base}/theses`)).theses,
  /** Extracts claims and checks them (up to ~30 s). */
  createThesis: async (text: string): Promise<Thesis> => parse(ThesisSchema, await api.post(`${base}/theses`, { text })),
  checkThesis: async (id: string): Promise<Thesis> => parse(ThesisSchema, await api.post(`${base}/theses/${enc(id)}/check`)),
  deleteThesis: (id: string): Promise<void> => api.del(`${base}/theses/${enc(id)}`).then(done),

  // ── screener (I0.17) ──
  parseQuery: async (question: string): Promise<QueryParseResponse> =>
    parse(QueryParseResponseSchema, await api.post(`${base}/query/parse`, { question })),
  runQuery: async (dsl: ScreenerDslInput): Promise<QueryResult> => parse(QueryResultSchema, await api.post(`${base}/query/run`, { dsl })),

  // ── order copilot (I0.18) ──
  previewOrder: async (req: OrderPreviewRequest): Promise<OrderPreview> =>
    parse(OrderPreviewSchema, await api.post(`${base}/order/preview`, req)),
  /** 409 = stale preview (isStalePreview). Never called without the operator's confirm click. */
  confirmOrder: async (intent: OrderIntent, previewHash: string): Promise<OrderConfirmResponse> =>
    parse(OrderConfirmResponseSchema, await api.post(`${base}/order/confirm`, { intent, previewHash })),

  // ── doc/contract watcher (I0.19) ──
  watches: async (): Promise<Watch[]> => parse(WatchesResponseSchema, await api.get(`${base}/watches`)).watches,
  addWatch: async (input: WatchInput): Promise<Watch> => parse(WatchSchema, await api.post(`${base}/watches`, input)),
  deleteWatch: (id: string): Promise<void> => api.del(`${base}/watches/${enc(id)}`).then(done),
  watchChanges: async (id: string): Promise<WatchChange[]> =>
    parse(WatchChangesResponseSchema, await api.get(`${base}/watches/${enc(id)}/changes`)).changes,
  checkWatch: (id: string): Promise<void> => api.post(`${base}/watches/${enc(id)}/check`).then(done),

  // ── flow (SPEC § Flow F1) ──
  heatmap: async (window: HeatmapWindow): Promise<HeatmapResponse> =>
    parse(HeatmapResponseSchema, await api.get(`${base}/heatmap${qs({ window })}`)),
  asset: async (coin: string, days: number): Promise<AssetDetailResponse> =>
    parse(AssetDetailResponseSchema, await api.get(`${base}/asset/${enc(coin)}${qs({ days })}`)),
  flows: async (since?: string): Promise<FlowFlag[]> => parse(FlowsResponseSchema, await api.get(`${base}/flows${qs({ since })}`)).flags,
}

/** 409 from `POST /order/confirm`: marks moved > 0.5% or > 60 s (DESIGN-terminal §7.4). */
export function isStalePreview(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409
}

// ── polling (DESIGN-terminal §1.4) ──

/** Cadences from DESIGN-terminal §1.4; anything not listed loads on mount + after a write. */
export const INTEL_POLL_MS = {
  positions: 60_000,
  alerts: 60_000,
  catalysts: 300_000,
  graph: 600_000,
  watches: 300_000,
  deskStatus: 60_000,
  /** 15-min data (DESIGN-terminal §15.2, §15.8). */
  heatmap: 300_000,
  asset: 300_000,
} as const

export type IntelState<T> = PollState<T>

/**
 * usePoll with the Intel defaults: no interval unless given (mount + refetch),
 * pauses while the tab is hidden, offline = no HTTP response at all.
 */
export function useIntel<T>(
  fetcher: () => Promise<T>,
  deps: unknown[],
  opts: { intervalMs?: number | null; enabled?: boolean } = {},
): IntelState<T> {
  return usePoll(fetcher, deps, { intervalMs: opts.intervalMs ?? null, enabled: opts.enabled ?? true })
}

// ── review throttle (DESIGN-terminal §1.5) ──
//
// Mounting `/` posts a brief (which logs a review) once per tab per 5 min, so
// hopping between sub-tabs does not reset the baseline. The module cache
// covers in-app navigation; sessionStorage (per tab, survives a reload) backs
// it up. Storage can throw (private mode, blocked site data): every access is
// guarded and the module cache alone still works. `/?review=1` and REVIEW NOW
// bypass the throttle and just record.

export const REVIEW_THROTTLE_MS = 5 * 60_000
const REVIEW_KEY = 'ht_intel_review_at'

let lastReview: { at: number; brief: Brief | null } | null = null

function storedReviewAt(): number | null {
  try {
    const raw = globalThis.sessionStorage?.getItem(REVIEW_KEY)
    const n = raw == null ? NaN : Number(raw)
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}

export const reviewThrottle = {
  /** True when this tab has not posted a brief in the last 5 minutes. */
  shouldPost(now = Date.now()): boolean {
    const at = Math.max(lastReview?.at ?? -Infinity, storedReviewAt() ?? -Infinity)
    return now - at >= REVIEW_THROTTLE_MS
  },
  /** Record a posted brief (after the POST succeeded). */
  record(brief: Brief | null, now = Date.now()): void {
    lastReview = { at: now, brief }
    try {
      globalThis.sessionStorage?.setItem(REVIEW_KEY, String(now))
    } catch {
      // storage unavailable: the module cache still throttles in-app hops
    }
  },
  /** The brief this tab last posted, when still in memory (for an in-app hop back to `/`). */
  lastBrief(): Brief | null {
    return lastReview?.brief ?? null
  },
  /** Test hook. */
  reset(): void {
    lastReview = null
    try {
      globalThis.sessionStorage?.removeItem(REVIEW_KEY)
    } catch {
      // ignore
    }
  },
}
