import { ApiError, NetworkError } from './api'
import { splitFrames } from './analyst'

// Client for /api/desk (SPEC.md "Desk"). Runs stream over POST + SSE like
// the analyst; everything else is plain JSON through api.ts.

export type Side = 'long' | 'short'
export type ProposalStatus = 'pending' | 'rejected' | 'blocked' | 'executed' | 'failed' | 'expired'

export interface Sizing {
  markPx: number
  size: number
  notionalUsd: number
  riskUsd: number
  stopDistPct: number
  rr: number
  feeUsd: number
  grossLeverageAfter: number
}

export interface Verdict {
  approved: boolean
  reasons: string[]
  warnings: string[]
  sizing?: Sizing
  equityUsd: number
  checkedAt: string
}

export interface TradeProposal {
  coin: string
  side: Side
  setup: string
  thesis: string
  horizon: string
  confidence: string
  stop: number
  target: number
  riskPct: number
  entryLimit?: number
  invalidation: string
  evidence: Array<{ source: string; point: string }>
}

export interface ExitProposal {
  coin: string
  fraction: number
  reason: string
}

export interface ProposalRecord {
  id: string
  runId: string | null
  kind: 'open' | 'exit'
  status: ProposalStatus
  venue: string
  proposal: TradeProposal | ExitProposal
  verdict: Verdict
  execution: { ok: boolean; fills: Array<{ side: string; size: number; px: number; fee: number; pnl: number }>; error?: string } | null
  decidedBy: string | null
  decidedAt: string | null
  expiresAt: string | null
  createdAt: string
}

export interface Position {
  coin: string
  side: Side
  size: number
  entryPx: number
  markPx: number
  stopPx: number | null
  tpPx: number | null
  unrealizedPnl: number
  notionalUsd: number
}

export interface AccountState {
  venue: string
  equityUsd: number
  dayPnlUsd: number
  positions: Position[]
  available: boolean
  note?: string
}

export interface DeskStatus {
  configured: boolean
  model: { provider: string; label: string; pm: string; scouts: string; scoutProvider: string; webSearch: boolean } | null
  venue: string
  /** True when orders reach Hyperliquid (testnet). */
  live: boolean
  /** The Hyperliquid account a live venue trades. */
  venueAccount: string | null
  /** Why a requested live venue is not in use (bad key, unsupported network). */
  venueNote: string | null
  approval: 'manual' | 'auto'
  killSwitch: { on: boolean; reason?: string; at?: string }
  limits: Record<string, number | string>
  watchlist: string[]
  watchAddress: string | null
  cyclesConnected: boolean
  channels: string[]
  specialists: Array<{ id: string; role: string; brief: string; webSearch: boolean }>
  schedule: { reviewEveryHours: number; maxCyclesPerDay: number; cycleCooldownMin: number }
}

export interface Portfolio {
  desk: AccountState
  watched: AccountState | null
  fills: Array<{ id: number; ts: string; coin: string; side: string; size: number; px: number; fee: number; pnl: number; reason: string }>
  startingEquity: number
}

export interface RunRow {
  id: string
  kind: 'ask' | 'cycle'
  question: string
  status: 'running' | 'done' | 'error'
  answer: string | null
  costUsd: number | null
  error: string | null
  startedAt: string
  finishedAt: string | null
}

export interface AlertRow {
  id: number
  ts: string
  level: 'info' | 'warn' | 'critical'
  title: string
  body: string
  channels: string[]
}

export type DeskEvent =
  | { type: 'run_start'; runId: string; kind: 'ask' | 'cycle'; question: string }
  | { type: 'agent_start'; agent: string; role: string; parent: string | null; task: string; model: string }
  | { type: 'agent_done'; agent: string; stop: string; rounds: number; report?: string }
  | { type: 'text'; agent: string; delta: string }
  | { type: 'reasoning'; agent: string; delta: string }
  | { type: 'tool_call'; agent: string; id: string; name: string; input: unknown; server: boolean }
  | { type: 'tool_result'; agent: string; id: string; name: string; ok: boolean; summary: string }
  | { type: 'citations'; citations: Array<{ url: string; title: string | null }> }
  | { type: 'proposal'; agent: string; id: string; kind: 'open' | 'exit'; status: ProposalStatus; coin: string; summary: string }
  | { type: 'alert'; agent: string; level: string; title: string }
  | { type: 'error'; agent: string; error: string }
  | { type: 'done'; runId: string; stop: string; usage: { input_tokens: number; output_tokens: number }; costUsd: number | null }

export interface AgentView {
  id: string
  role: string
  parent: string | null
  task: string
  model: string
  state: 'running' | 'done' | 'error'
  stop?: string
  text: string
  tools: Array<{ id: string; name: string; server: boolean; ok?: boolean; summary?: string }>
}

export interface RunView {
  runId: string | null
  kind: 'ask' | 'cycle'
  question: string
  agents: AgentView[]
  proposals: Array<Extract<DeskEvent, { type: 'proposal' }>>
  alerts: Array<Extract<DeskEvent, { type: 'alert' }>>
  errors: string[]
  citations: Array<{ url: string; title: string | null }>
  done?: Extract<DeskEvent, { type: 'done' }>
}

export function emptyRun(kind: 'ask' | 'cycle', question: string): RunView {
  return { runId: null, kind, question, agents: [], proposals: [], alerts: [], errors: [], citations: [] }
}

/** Folds one event into the run view (pure; also used to replay stored runs). */
export function reduceRun(v: RunView, e: DeskEvent): RunView {
  const agent = (id: string, f: (a: AgentView) => AgentView) => ({ ...v, agents: v.agents.map((a) => (a.id === id ? f(a) : a)) })
  switch (e.type) {
    case 'run_start':
      return { ...v, runId: e.runId, kind: e.kind, question: e.question }
    case 'agent_start':
      return { ...v, agents: [...v.agents, { id: e.agent, role: e.role, parent: e.parent, task: e.task, model: e.model, state: 'running', text: '', tools: [] }] }
    case 'text':
      return agent(e.agent, (a) => ({ ...a, text: a.text + e.delta }))
    case 'tool_call':
      // Narration before a tool round is not the report; keep only the last round's text.
      return agent(e.agent, (a) => ({ ...a, text: '', tools: [...a.tools, { id: e.id, name: e.name, server: e.server }] }))
    case 'tool_result':
      return agent(e.agent, (a) => ({ ...a, tools: a.tools.map((t) => (t.id === e.id ? { ...t, ok: e.ok, summary: e.summary } : t)) }))
    case 'agent_done':
      return agent(e.agent, (a) => ({ ...a, state: e.stop === 'end' ? 'done' : 'error', stop: e.stop, text: e.report ?? a.text }))
    case 'proposal':
      return { ...v, proposals: [...v.proposals, e] }
    case 'alert':
      return { ...v, alerts: [...v.alerts, e] }
    case 'error':
      return { ...v, errors: [...v.errors, `${e.agent}: ${e.error}`] }
    case 'citations':
      return { ...v, citations: e.citations }
    case 'done':
      return { ...v, done: e, agents: v.agents.map((a) => (a.state === 'running' ? { ...a, state: 'error', stop: e.stop } : a)) }
    default:
      return v
  }
}

async function failFrom(res: Response): Promise<never> {
  if (res.status === 401) {
    sessionStorage.setItem('ht_redirect_to', location.pathname)
    location.href = '/login'
    throw new ApiError('unauthorized', 401)
  }
  const body = (await res.json().catch(() => null)) as { error?: string } | null
  throw new ApiError(body?.error ?? res.statusText, res.status)
}

/** POSTs to a streaming desk endpoint (/desk/ask, /desk/review) and feeds each event to onEvent. */
export async function streamDesk(path: '/desk/ask' | '/desk/review', body: unknown, onEvent: (e: DeskEvent) => void, signal?: AbortSignal): Promise<void> {
  let res: Response
  try {
    res = await fetch(`/api${path}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(body ?? {}),
      signal,
    })
  } catch (err) {
    if (signal?.aborted) return
    throw new NetworkError(err instanceof Error ? err.message : 'network unreachable')
  }
  if (!res.ok || !res.body) return failFrom(res)
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const [frames, rest] = splitFrames(buf)
      buf = rest
      for (const f of frames) {
        try {
          onEvent({ type: f.event, ...JSON.parse(f.data) } as DeskEvent)
        } catch {
          // skip a malformed frame
        }
      }
    }
  } catch (err) {
    if (signal?.aborted) return
    throw new NetworkError(err instanceof Error ? err.message : 'stream interrupted')
  }
}

export const fmtUsd = (x: number) => `${x < 0 ? '−' : ''}$${Math.abs(x).toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`

export function fmtPx(x: number | null | undefined): string {
  if (x == null || !Number.isFinite(x)) return '—'
  const a = Math.abs(x)
  return a >= 1000 ? x.toLocaleString(undefined, { maximumFractionDigits: 1 }) : a >= 1 ? x.toFixed(3) : x.toPrecision(4)
}
