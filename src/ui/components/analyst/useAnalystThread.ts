import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, NetworkError } from '../../lib/api'
import {
  compactSim,
  streamAnalyst,
  type AnalystChoice,
  type AnalystCitation,
  type AnalystMode,
  type AnalystStreamEvent,
  type AnalystUsage,
  type HistoryTurn,
  type SimResultEvent,
} from '../../lib/analyst'

// The analyst thread behind /analyst and the ASK drawer: turn state, the module-level session store (so in-flight and
// unsaved turns survive route changes and are shared between the page and the drawer), streaming, abort and storage.

const SESSION_STORAGE_KEY = 'ht_analyst_session_v2'
const SIM_SESSION_STORAGE_KEY = 'ht_paths_session_v1'
const HISTORY_TURNS = 10 // prior turns sent back as context
const STORED_TURNS = 30
const SIM_STORED_TURNS = 10 // sim cards carry equity arrays

export interface TraceItem {
  id: string
  name: string
  server: boolean
  input: unknown
  result?: { ok: boolean; summary: string }
}

export interface TurnState {
  id: number
  question: string
  /** Who was asked (catalog labels at ask time), shown before `done` arrives. */
  asked: { provider: string; model: string; effort?: string } | null
  answer: string
  reasoning: string
  trace: TraceItem[]
  /** simulate_paths results (sim mode), in arrival order. */
  sims: SimResultEvent[]
  /** "<simId>#<branchIndex>" → saved branch id (survives reload: no duplicate saves). */
  saved: Record<string, string>
  citations: AnalystCitation[]
  error: string | null
  done: { usage: AnalystUsage; model: string; provider: string; label?: string; effort?: string; rounds: number; stop: string } | null
  streaming: boolean
  startedAt: number
  finishedAt: number | null
}

export type Offline = { title: string; message: string } | null

export function offlineFrom(err: unknown): Offline {
  if (err instanceof ApiError && err.status === 503) {
    return {
      title: 'ANALYST NOT CONFIGURED',
      message:
        'set at least one provider key on the server: ANTHROPIC_API_KEY (or ANALYST_ANTHROPIC_API_KEY), OPENAI_API_KEY, GEMINI_API_KEY, XAI_API_KEY, DEEPSEEK_API_KEY, MOONSHOT_API_KEY, DASHSCOPE_API_KEY or OPENROUTER_API_KEY (README "Analyst")',
    }
  }
  if (err instanceof NetworkError || (err instanceof ApiError && err.status === 502)) {
    return { title: 'ANALYST UNREACHABLE', message: 'check your connection and retry' }
  }
  return null
}

function loadSession(key: string): TurnState[] {
  try {
    const raw = localStorage.getItem(key)
    const v = raw ? (JSON.parse(raw) as TurnState[]) : []
    return Array.isArray(v)
      ? v.filter((t) => t && typeof t.question === 'string').map((t) => ({ ...t, sims: t.sims ?? [], saved: t.saved ?? {}, streaming: false }))
      : []
  } catch {
    return []
  }
}

function saveSession(key: string, max: number, turns: TurnState[]) {
  const keep = turns
    .filter((t) => !t.streaming)
    .slice(-max)
    .map((t) => ({ ...t, reasoning: t.reasoning.slice(0, 4000), sims: t.sims.map(compactSim) }))
  // Quota: drop the oldest turn and retry; the session still lives for the tab.
  for (let from = 0; from <= keep.length; from++) {
    try {
      localStorage.setItem(key, JSON.stringify(keep.slice(from)))
      return
    } catch {
      // Storage full or blocked.
    }
  }
}

let nextId = 1

// Module-level store: keeps in-flight/unsaved turns alive across route changes. React state mirrors it.
let sessionThreads: Record<AnalystMode, TurnState[]> | null = null
const listeners = new Set<(t: Record<AnalystMode, TurnState[]>) => void>()
const inflight: Record<AnalystMode, AbortController | null> = { ask: null, sim: null }

function seedThreads(): Record<AnalystMode, TurnState[]> {
  if (!sessionThreads) {
    sessionThreads = { ask: loadSession(SESSION_STORAGE_KEY), sim: loadSession(SIM_SESSION_STORAGE_KEY) }
    nextId = Math.max(nextId, 0, ...sessionThreads.ask.map((t) => t.id), ...sessionThreads.sim.map((t) => t.id)) + 1
  }
  return sessionThreads
}

function setTurnsFor(m: AnalystMode, fn: (ts: TurnState[]) => TurnState[]) {
  const th = seedThreads()
  sessionThreads = { ...th, [m]: fn(th[m]) }
  for (const l of listeners) l(sessionThreads)
}

export function applyEvent(t: TurnState, e: AnalystStreamEvent, now = Date.now()): TurnState {
  switch (e.type) {
    case 'text':
      return { ...t, answer: t.answer + e.delta }
    case 'reasoning':
      return { ...t, reasoning: t.reasoning + e.delta }
    case 'tool_call':
      return { ...t, trace: [...t.trace, { id: e.id, name: e.name, server: e.server, input: e.input }] }
    case 'tool_result':
      return { ...t, trace: t.trace.map((x) => (x.id === e.id ? { ...x, result: { ok: e.ok, summary: e.summary } } : x)) }
    case 'sim_result':
      return { ...t, sims: [...t.sims, e] }
    case 'citations':
      return { ...t, citations: e.citations }
    case 'error':
      return { ...t, error: e.error }
    case 'done':
      return {
        ...t,
        streaming: false,
        finishedAt: now,
        done: { usage: e.usage, model: e.model, provider: e.provider, label: e.label, effort: e.effort, rounds: e.rounds, stop: e.stop },
      }
  }
  return t
}

/** Sim turns end their assistant content with a "[paths]" trailer of each path's normalized {name, config} (SPEC decision 8). */
export function toHistory(turns: TurnState[], mode: AnalystMode = 'ask'): HistoryTurn[] {
  const out: HistoryTurn[] = []
  for (const t of turns.slice(-HISTORY_TURNS)) {
    if ((!t.answer.trim() && !t.sims.length) || t.streaming) continue
    const trailer =
      mode === 'sim' && t.sims.length
        ? `\n\n[paths]\n${t.sims.flatMap((s) => s.branches.map((b) => JSON.stringify({ name: b.name, config: b.config }))).join('\n')}`
        : ''
    out.push({ role: 'user', content: t.question }, { role: 'assistant', content: t.answer + trailer })
  }
  return out
}

export interface UseAnalystThread {
  turns: TurnState[]
  busy: boolean
  /** `question` is what the thread shows and replays as history; `send` (default the same) is what the model receives. */
  ask: (question: string, send?: string) => Promise<void>
  stop: () => void
  clear: () => void
  markSaved: (turnId: number, key: string, branchId: string) => void
}

/** `abortOnUnmount: false` lets a turn keep streaming into the shared store after its view closes (the drawer). */
export function useAnalystThread(opts: {
  mode: AnalystMode
  choice: AnalystChoice | null
  onError?: (err: unknown) => void
  abortOnUnmount?: boolean
}): UseAnalystThread {
  const { mode, choice, onError, abortOnUnmount = true } = opts
  const [threads, setThreads] = useState<Record<AnalystMode, TurnState[]>>(seedThreads)
  const turns = threads[mode]
  const busy = turns.some((t) => t.streaming)
  const mine = useRef<AbortController | null>(null)
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError

  useEffect(() => {
    listeners.add(setThreads)
    setThreads(seedThreads())
    return () => {
      listeners.delete(setThreads)
    }
  }, [])

  useEffect(() => {
    if (!busy) {
      saveSession(SESSION_STORAGE_KEY, STORED_TURNS, threads.ask)
      saveSession(SIM_SESSION_STORAGE_KEY, SIM_STORED_TURNS, threads.sim)
    }
  }, [threads, busy])

  useEffect(
    () => () => {
      if (abortOnUnmount && mine.current) mine.current.abort()
    },
    [abortOnUnmount],
  )

  const ask = useCallback(
    async (question: string, send?: string) => {
      const q = question.trim()
      if (!q || busy) return
      const id = nextId++
      const m = mode
      const history = toHistory(turns, m)
      const fresh: TurnState = {
        id,
        question: q,
        asked: choice ? { provider: choice.provider, model: choice.model, effort: choice.effort } : null,
        answer: '',
        reasoning: '',
        trace: [],
        sims: [],
        saved: {},
        citations: [],
        error: null,
        done: null,
        streaming: true,
        startedAt: Date.now(),
        finishedAt: null,
      }
      setTurnsFor(m, (ts) => [...ts, fresh])
      const ctrl = new AbortController()
      mine.current = ctrl
      inflight[m] = ctrl
      const update = (fn: (t: TurnState) => TurnState) => setTurnsFor(m, (ts) => ts.map((t) => (t.id === id ? fn(t) : t)))
      try {
        // choice is undefined until the catalog loads — the server then uses its own default.
        await streamAnalyst(send ?? q, history, (e) => update((t) => applyEvent(t, e)), ctrl.signal, choice ?? undefined, m)
        update((t) =>
          t.streaming
            ? { ...t, streaming: false, finishedAt: Date.now(), error: t.error ?? (ctrl.signal.aborted ? 'stopped' : 'stream ended without a done event') }
            : t,
        )
      } catch (err) {
        onErrorRef.current?.(err)
        update((t) => ({ ...t, streaming: false, finishedAt: Date.now(), error: err instanceof Error ? err.message : String(err) }))
      } finally {
        if (mine.current === ctrl) mine.current = null
        if (inflight[m] === ctrl) inflight[m] = null
      }
    },
    [busy, turns, choice, mode],
  )

  const stop = useCallback(() => inflight[mode]?.abort(), [mode])
  const clear = useCallback(() => setTurnsFor(mode, () => []), [mode])
  const markSaved = useCallback(
    (turnId: number, key: string, branchId: string) =>
      setTurnsFor(mode, (ts) => ts.map((t) => (t.id === turnId ? { ...t, saved: { ...t.saved, [key]: branchId } } : t))),
    [mode],
  )

  return { turns, busy, ask, stop, clear, markSaved }
}

