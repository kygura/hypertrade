import type {
  AccountState,
  DeskEvent,
  ExitProposal,
  OperatorOrderRecord,
  Position,
  ProposalRecord as ServerProposalRecord,
  ProposalStatus,
  Side,
  Sizing,
  TradeProposal,
  Verdict,
} from '../../server/desk/types'
import type { AlertRow as ServerAlertRow, RunRow as ServerRunRow } from '../../server/desk/store'
import { streamSse } from './sse'
import { fmtUsd, fmtPx } from './format'

// Client for /api/desk (docs/SPEC.md "Desk"). Runs stream over POST + SSE like
// the analyst; everything else is plain JSON through api.ts. Wire types are the
// server's own (type-only import, erased at build), as in lib/lab.ts.

export type { AccountState, DeskEvent, ExitProposal, OperatorOrderRecord, Position, ProposalStatus, Side, Sizing, TradeProposal, Verdict }

/** Server record with the field the wire narrows: `execution` is `unknown` server-side. */
export type ProposalRecord = Omit<ServerProposalRecord, 'execution'> & {
  execution: { ok: boolean; fills: Array<{ side: string; size: number; px: number; fee: number; pnl: number }>; error?: string } | null
}
export type RunRow = Omit<ServerRunRow, 'trigger' | 'usage'>
/** Rows from GET /desk/alerts always carry their id. */
export type AlertRow = Omit<ServerAlertRow, 'id' | 'runId'> & { id: number }

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
  schedule: { reviewEveryHours: number; reviewEveryHoursSource: 'ui' | 'env'; maxCyclesPerDay: number; cycleCooldownMin: number }
}

export interface Portfolio {
  desk: AccountState
  watched: AccountState | null
  fills: Array<{ id: number; ts: string; coin: string; side: string; size: number; px: number; fee: number; pnl: number; reason: string }>
  startingEquity: number
}

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

/** POSTs to a streaming desk endpoint (/desk/ask, /desk/review) and feeds each event to onEvent. */
export const streamDesk = (path: '/desk/ask' | '/desk/review', body: unknown, onEvent: (e: DeskEvent) => void, signal?: AbortSignal): Promise<void> =>
  streamSse<DeskEvent>(`/api${path}`, body ?? {}, onEvent, signal)

export { fmtUsd, fmtPx }
