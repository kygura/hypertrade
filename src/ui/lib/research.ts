import { boardStudy, BoardResponseSchema, RadarResponseSchema, StudyResponseSchema, type ResearchSignal, type StudySummary, type ResearchSource, type StudyRequest, type StudyResponse } from '../../shared/research'
import type { RadarCall } from '../../shared/radar'
import { ApiError, api, parseWith } from './api'
import { DEFAULT_TOP, studyHref } from './study'

// Research board client (docs/RESEARCH.md "Board"): the three routes parsed with the shared
// zod schemas, plus the board's pure helpers (grouping, the `/` redirect rule, links), tested
// in research.test.ts.

const board = parseWith(BoardResponseSchema, 'research board')
const radar = parseWith(RadarResponseSchema, 'radar')
const study = parseWith(StudyResponseSchema, 'research study')

/** A board signal (`scope`: the study runs on this coin or on the Lab's top-N universe; `tested`: the side the rule tests). */
export type BoardSignal = ResearchSignal

/** Row click / Enter: the prefilled /lab/study (this coin, or the default top-N universe for `universe` scope), null without a rule. */
export const signalStudyHref = (s: BoardSignal): string | null => (s.rule ? studyHref(s.rule, s.scope === 'coin' ? s.coin : null) : null)

export const research = {
  board: async () => board(await api.get('/research/board')),
  radar: async () => radar(await api.get('/radar')),
  /**
   * Runs (or returns today's cached) event study of a signal's rule in its scope; a trial like a direct
   * lab_event_study call. The body is `boardStudy(signal)`, the one the board keys its cached evidence on.
   */
  study: async (s: BoardSignal): Promise<StudyResponse> => {
    const body = boardStudy(s)
    if (!body) throw new Error('this signal has no Lab rule to study')
    return research.run(body)
  },
  /** POST /api/research/study with a canonical body (`studyRoute` in lib/study.ts, or `boardStudy`). */
  run: async (body: StudyRequest): Promise<StudyResponse> => study(await api.post('/research/study', body)),
}

/** Keyboard on the board: j/k move, Enter open, s study in place; null while typing, in a dialog or with a modifier. */
export function boardKey(e: { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; target?: string; editable?: boolean; dialogOpen: boolean }): 'next' | 'prev' | 'open' | 'study' | null {
  if (e.ctrlKey || e.metaKey || e.altKey || e.dialogOpen || e.editable) return null
  if (e.target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.toUpperCase())) return null
  return e.key === 'j' ? 'next' : e.key === 'k' ? 'prev' : e.key === 'Enter' ? 'open' : e.key === 's' ? 'study' : null
}

/** Board poll cadence. */
export const BOARD_POLL_MS = 30_000

/** The board filtered to one coin (Cockpit detail, /asset/:coin: EVIDENCE). */
export const boardHref = (coin: string) => `/?coin=${encodeURIComponent(coin)}`

export const SOURCE_LABEL: Record<ResearchSource, string> = { novelty: 'NOVELTY', rule: 'RULE', opportunity: 'SETUP', radar: 'RADAR', definition: 'DEFINITION' }

/** One block of the signal list: a coin with more than one signal is a group, else a lone row. */
export interface SignalBlock {
  coin: string
  /** True when this block groups several signals of one coin. */
  grouped: boolean
  signals: BoardSignal[]
}

/**
 * Board order: newest first; a coin with more than one signal is grouped at the position of its newest
 * signal, its rows newest first. `coin` filters case-insensitively before grouping.
 */
export function signalBlocks(signals: readonly BoardSignal[], coin?: string | null): SignalBlock[] {
  const want = coin?.trim().toUpperCase() || null
  const sorted = signals.filter((s) => !want || s.coin.toUpperCase() === want).sort((a, b) => b.at - a.at || a.id.localeCompare(b.id))
  const byCoin = new Map<string, BoardSignal[]>()
  for (const s of sorted) byCoin.set(s.coin, [...(byCoin.get(s.coin) ?? []), s])
  return [...byCoin].map(([c, list]) => ({ coin: c, grouped: list.length > 1, signals: list }))
}

/** Signals in the order the board shows them (keyboard j/k walks this). */
export const flatSignals = (blocks: readonly SignalBlock[]) => blocks.flatMap((b) => b.signals)

/** Cockpit feed params that once lived on `/` (Cockpit.tsx: ?id, ?status, ?tier, ?liqh, ?liq). */
export const FEED_PARAMS = ['id', 'status', 'tier', 'liqh', 'liq'] as const

/**
 * Where a visit to `/` with this query belongs. `?review=1` (old Telegram links) → `/terminal?review=1`;
 * any Cockpit feed param → `/feed` with the query intact; otherwise null (the board, which reads only `?coin=`).
 */
export function rootRedirect(search: string): string | null {
  const q = new URLSearchParams(search)
  if (q.get('review') === '1') return '/terminal?review=1'
  if (FEED_PARAMS.some((k) => q.has(k))) return `/feed?${q}`
  return null
}

/** Radar calls for the side column: newest first, at most `n`. */
export function recentCalls(calls: readonly RadarCall[], n = 6): RadarCall[] {
  return [...calls].sort((a, b) => b.date.localeCompare(a.date) || b.at.localeCompare(a.at)).slice(0, n)
}

// ─── auth and the evidence cell (pure, tested) ───

/** Who is looking, from the /auth/me probe. A failed probe is an error with a retry, never an endless load. */
export type Auth = { state: 'loading' } | { state: 'guest' } | { state: 'user' } | { state: 'error'; message: string }

export function authOf(me: { data: { guest?: boolean } | null; error: string | null; offline: boolean }): Auth {
  if (me.data) return { state: me.data.guest === true ? 'guest' : 'user' }
  if (me.error) return { state: 'error', message: me.error }
  if (me.offline) return { state: 'error', message: 'api unreachable' }
  return { state: 'loading' }
}

/** A study run in place from a row. */
export type RowStudy = { state: 'running' } | { state: 'error'; message: string } | { state: 'sign-in' } | { state: 'done'; summary: StudySummary }

/** Key of a row's local study: the signal and the UTC day, so yesterday's run never shows as today's evidence. */
export const rowStudyKey = (id: string, now: number) => `${id}|${new Date(now).toISOString().slice(0, 10)}`

/** What a failed study run leaves in the cell: a 401 means sign in (the redirect is in flight), else the error verbatim. */
export function studyFailed(err: unknown): RowStudy {
  if (err instanceof ApiError && err.status === 401) return { state: 'sign-in' }
  return { state: 'error', message: err instanceof Error && err.message ? err.message : 'request failed' }
}

export type CellState =
  | { kind: 'evidence'; summary: StudySummary }
  | { kind: 'no-twin' }
  | { kind: 'running' }
  | { kind: 'sign-in' }
  | { kind: 'auth-loading' }
  | { kind: 'auth-error'; message: string }
  | { kind: 'idle'; error: string | null }

/**
 * The evidence cell of a row: idle → running → evidence | error (idle with the message, STUDY retries) | sign-in.
 * Cached evidence wins; no rule is `no Lab twin`; a guest never gets a STUDY button (the POST needs a session),
 * and nothing runs until /auth/me has answered.
 */
export function cellState(s: Pick<ResearchSignal, 'rule' | 'evidence'>, local: RowStudy | undefined, auth: Auth): CellState {
  const ev = (s.evidence?.kind === 'study' ? s.evidence : null) ?? (local?.state === 'done' ? local.summary : null)
  if (ev) return { kind: 'evidence', summary: ev }
  if (!s.rule) return { kind: 'no-twin' }
  if (local?.state === 'running') return { kind: 'running' }
  if (auth.state === 'guest' || local?.state === 'sign-in') return { kind: 'sign-in' }
  if (auth.state === 'loading') return { kind: 'auth-loading' }
  if (auth.state === 'error') return { kind: 'auth-error', message: auth.message }
  return { kind: 'idle', error: local?.state === 'error' ? local.message : null }
}

/** What was studied: the signal's own coin, or the Lab's default universe (a universe study is not the coin's history). */
export const scopeLabel = (scope: ResearchSignal['scope']) => (scope === 'coin' ? 'this coin' : `top-${DEFAULT_TOP} universe`)
