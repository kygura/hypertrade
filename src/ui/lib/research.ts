import {
  boardStudy, BoardResponseSchema, DefinitionsResponseSchema, RadarResponseSchema, SetupReplayResponseSchema, StudyResponseSchema, type DefinitionsResponse, type LedgerEvidence, type SetupReplayResponse, type SetupReplayRow, type ResearchSignal, type ScorecardEvidence, type StudySummary,
  type ResearchSource, type StudyRequest, type StudyResponse,
} from '../../shared/research'
import { CI_MIN_CLUSTERS } from '../../shared/platform'
import type { RadarCall } from '../../shared/radar'
import { ApiError, api, parseWith } from './api'
import { fmtSigned } from './lab'
import { DEFAULT_TOP, studyHref } from './study'

// Research board client (docs/RESEARCH.md "Board"): the three routes parsed with the shared
// zod schemas, plus the board's pure helpers (grouping, the `/` redirect rule, links), tested
// in research.test.ts.

const board = parseWith(BoardResponseSchema, 'research board')
const radar = parseWith(RadarResponseSchema, 'radar')
const study = parseWith(StudyResponseSchema, 'research study')
const definitions = parseWith(DefinitionsResponseSchema, 'research definitions')
const replay = parseWith(SetupReplayResponseSchema, 'setup replay')

/** A board signal (`scope`: the study runs on this coin or on the Lab's top-N universe; `tested`: the side the rule tests). */
export type BoardSignal = ResearchSignal

/** Row click / Enter: the prefilled /lab/study (this coin, or the default top-N universe for `universe` scope), null without a rule. */
export const signalStudyHref = (s: BoardSignal): string | null => (s.rule ? studyHref(s.rule, s.scope === 'coin' ? s.coin : null) : null)

export const research = {
  board: async () => board(await api.get('/research/board')),
  radar: async () => radar(await api.get('/radar')),
  /** The shipped signal definitions (the /lab/study DEFINITIONS picker). */
  definitions: async () => definitions(await api.get('/research/definitions')),
  /** Intraday setup replay (RESEARCH.md S5): `pending` while the first run is in flight, polled by the caller. */
  replay: async () => replay(await api.get('/research/setups/replay?source=candles')),
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
  | { kind: 'ledger'; evidence: LedgerEvidence }
  | { kind: 'scorecard'; evidence: ScorecardEvidence }
  | { kind: 'none'; source: ResearchSource }
  | { kind: 'running' }
  | { kind: 'sign-in' }
  | { kind: 'auth-loading' }
  | { kind: 'auth-error'; message: string }
  | { kind: 'idle'; error: string | null }

type CellSignal = Pick<ResearchSignal, 'rule' | 'evidence' | 'source'>

/**
 * The evidence cell of a row. A setup shows its ledger record and a radar call its scorecard row, never a study
 * (their rule, when one maps, is the daily version: `dailyState`). Otherwise: idle → running → evidence | error (idle
 * with the message, STUDY retries) | sign-in. Cached evidence wins; a guest never gets a STUDY button (the POST needs a
 * session), and nothing runs until /auth/me has answered. No evidence and nothing to run is `none`.
 */
export function cellState(s: CellSignal, local: RowStudy | undefined, auth: Auth): CellState {
  if (s.evidence?.kind === 'ledger') return { kind: 'ledger', evidence: s.evidence }
  if (s.evidence?.kind === 'scorecard') return { kind: 'scorecard', evidence: s.evidence }
  if (s.source === 'opportunity' || s.source === 'radar') return { kind: 'none', source: s.source }
  return studyCell(s, s.evidence?.kind === 'study' ? s.evidence : null, local, auth)
}

/** An opportunity's daily-version study (its `rule` is the daily definition, universe scope): the same ladder as a row's own study; null for other rows. */
export function dailyState(s: CellSignal & Pick<ResearchSignal, 'dailyStudy'>, local: RowStudy | undefined, auth: Auth): CellState | null {
  if (s.source !== 'opportunity' || !s.rule) return null
  return studyCell(s, s.dailyStudy, local, auth)
}

/** What a row's STUDY control is in now: the daily version for a setup, the row's own study otherwise (the `s` key reads it). */
export const runState = (s: CellSignal & Pick<ResearchSignal, 'dailyStudy'>, local: RowStudy | undefined, auth: Auth): CellState => dailyState(s, local, auth) ?? cellState(s, local, auth)

function studyCell(s: Pick<CellSignal, 'rule' | 'source'>, cached: StudySummary | null, local: RowStudy | undefined, auth: Auth): CellState {
  const ev = cached ?? (local?.state === 'done' ? local.summary : null)
  if (ev) return { kind: 'evidence', summary: ev }
  if (!s.rule) return { kind: 'none', source: s.source }
  if (local?.state === 'running') return { kind: 'running' }
  if (auth.state === 'guest' || local?.state === 'sign-in') return { kind: 'sign-in' }
  if (auth.state === 'loading') return { kind: 'auth-loading' }
  if (auth.state === 'error') return { kind: 'auth-error', message: auth.message }
  return { kind: 'idle', error: local?.state === 'error' ? local.message : null }
}

/** What was studied: the signal's own coin, or the Lab's default universe (a universe study is not the coin's history). */
export const scopeLabel = (scope: ResearchSignal['scope']) => (scope === 'coin' ? 'this coin' : `top-${DEFAULT_TOP} universe`)

/** `tested short · top-20 universe`: the side the rule tests (a fact about the study, not advice) and what it covers. */
export const testedLabel = (s: Pick<ResearchSignal, 'tested' | 'scope'>) => `${s.tested ? `tested ${s.tested} · ` : ''}${scopeLabel(s.scope)}`

/** Fraction → signed percent to two decimals: `+0.42%`. */
const pctFrac = (x: number) => `${fmtSigned(x * 100, 2)}%`

/**
 * A setup's ledger record as a fact line: `live record · 14 outcomes · 6 clusters · mean +0.42% [−0.10%, +0.95%] · 24h`.
 * `meanNet` is the mean net return per outcome over cluster means (a fraction, not R); the interval is null under 5
 * clusters and then omitted. No outcomes: a plain statement. Never a verdict.
 */
export function ledgerText(e: LedgerEvidence): string {
  if (e.n === 0) return 'no graded outcomes yet'
  const mean = e.meanNet == null ? '' : ` · mean net ${pctFrac(e.meanNet)}${e.ci95 ? ` [${pctFrac(e.ci95[0])}, ${pctFrac(e.ci95[1])}]` : ''}`
  return `live record · ${e.n} outcome${e.n === 1 ? '' : 's'} · ${e.clusters} cluster${e.clusters === 1 ? '' : 's'}${mean} · ${e.horizon}`
}

/** A radar call's scorecard row: `graded forward · 4 calls · mean vs BTC +2.1% · hit 75%` (% moves signed by the called direction). */
export function scorecardText(e: ScorecardEvidence): string {
  if (e.n === 0) return 'no graded calls yet'
  return `graded forward · ${e.n} call${e.n === 1 ? '' : 's'} · mean vs BTC ${fmtSigned(e.meanPct, 1)}% · hit ${Math.round(e.hitRate * 100)}%`
}

/** The muted line when a row has no evidence and nothing to run: what is missing, as a fact. */
export const noEvidenceText = (source: ResearchSource) => (source === 'radar' ? 'no graded calls yet' : 'no record yet')

// ─── intraday setup replay (RESEARCH.md S5; a replay of the shipped predicates, not a trial) ───

/** A pending replay (first run, 4–5 min) is asked again this often. */
export const REPLAY_POLL_MS = 25_000
/** The replay's 95% interval is null under this many clusters (docs/RESEARCH.md S5): the server's groupStats constant. */
export const REPLAY_MIN_CLUSTERS = CI_MIN_CLUSTERS

/** 24h when the replay grades it, else the longest horizon it has. */
export const defaultReplayHorizon = (horizons: readonly string[]): string => (horizons.includes('24h') ? '24h' : (horizons[horizons.length - 1] ?? ''))

/** The rows of one horizon, in the server's order (kind × side). */
export const replayRowsAt = (r: Pick<SetupReplayResponse, 'setups'>, horizon: string): SetupReplayRow[] => r.setups.filter((x) => x.horizon === horizon)

/** `vol_expansion_breakout` → `vol expansion breakout`. */
export const kindLabel = (kind: string) => kind.replace(/_/g, ' ')

/** The daily definition that shares a platform setup kind's thesis on this side (`intradayKinds` + the rule's direction), if any. */
export const definitionForKind = (defs: DefinitionsResponse | null, kind: string, side: 'long' | 'short') =>
  defs?.definitions.find((d) => d.rule.direction === side && d.intradayKinds.includes(kind)) ?? null

/** A replay row's numbers as facts: each null number says why, from the data (never a 0). */
export function replayFacts(r: SetupReplayRow): { mean: string; interval: string; hit: string; note: string | null } {
  if (r.n === 0) return { mean: '—', interval: '—', hit: '—', note: r.entries === 0 ? 'no entries in the window' : `${r.entries} entries, none graded at ${r.horizon}` }
  return {
    mean: r.meanNet == null ? '—' : pctFrac(r.meanNet),
    interval: r.ci95 ? `[${pctFrac(r.ci95[0])}, ${pctFrac(r.ci95[1])}]` : '—',
    hit: r.hitRate == null ? '—' : `${Math.round(r.hitRate * 100)}%`,
    note: r.ci95 ? null : `interval needs ${REPLAY_MIN_CLUSTERS}+ clusters (has ${r.clusters})`,
  }
}
