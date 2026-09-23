import { useCallback, useEffect, useRef, useState } from 'react'
import { Badge, Button, ErrorBlock, OfflineBlock, SkeletonRows } from '../components'
import { ApiError, NetworkError } from '../lib/api'
import {
  getAnalystStatus,
  streamAnalyst,
  type AnalystCitation,
  type AnalystStatus,
  type AnalystStreamEvent,
  type AnalystUsage,
  type HistoryTurn,
} from '../lib/analyst'

// /analyst — natural-language analyst over the app's data (SPEC.md
// "Analyst"). Read-only market intelligence: it reads briefings, sectors,
// metrics, markets and the engine's decisions, and can search the web; it
// never places, approves or rejects anything (Jev and the operator do that
// on the engine pages and in the Hyperion terminal).
//
// State vocabulary (DESIGN.md §6): status probe → SkeletonRows; 503 →
// OfflineBlock "ANALYST NOT CONFIGURED"; 502/network → OfflineBlock
// "ANALYST UNREACHABLE"; per-turn failures → verbatim ErrorBlock under the
// turn. The in-flight indicator is the .pulse-label on the ASK button.

const QUICK_PROMPTS = [
  'What changed since the last briefing?',
  'Explain the last 5 engine decisions.',
  'Which sector is rotating?',
]

const HISTORY_TURNS = 10 // prior turns sent back as context

interface TraceItem {
  id: string
  name: string
  server: boolean
  input: unknown
  result?: { ok: boolean; summary: string }
}

interface TurnState {
  id: number
  question: string
  answer: string
  trace: TraceItem[]
  citations: AnalystCitation[]
  error: string | null
  done: { usage: AnalystUsage; model: string; rounds: number; stop: string } | null
  streaming: boolean
}

// Session memory: survives route changes within the tab, gone on reload.
let sessionTurns: TurnState[] = []
let nextId = 1

type Offline = { title: string; message: string } | null

function offlineFrom(err: unknown): Offline {
  if (err instanceof ApiError && err.status === 503) {
    return { title: 'ANALYST NOT CONFIGURED', message: 'set ANALYST_API_KEY (and optionally ANALYST_PROVIDER, ANALYST_MODEL) on the server' }
  }
  if (err instanceof NetworkError || (err instanceof ApiError && err.status === 502)) {
    return { title: 'ANALYST UNREACHABLE', message: 'check your connection and retry' }
  }
  return null
}

function applyEvent(t: TurnState, e: AnalystStreamEvent): TurnState {
  switch (e.type) {
    case 'text':
      return { ...t, answer: t.answer + e.delta }
    case 'tool_call':
      return { ...t, trace: [...t.trace, { id: e.id, name: e.name, server: e.server, input: e.input }] }
    case 'tool_result':
      return { ...t, trace: t.trace.map((x) => (x.id === e.id ? { ...x, result: { ok: e.ok, summary: e.summary } } : x)) }
    case 'citations':
      return { ...t, citations: e.citations }
    case 'error':
      return { ...t, error: e.error }
    case 'done':
      return { ...t, streaming: false, done: { usage: e.usage, model: e.model, rounds: e.rounds, stop: e.stop } }
  }
}

function toHistory(turns: TurnState[]): HistoryTurn[] {
  const out: HistoryTurn[] = []
  for (const t of turns.slice(-HISTORY_TURNS)) {
    if (!t.answer.trim() || t.streaming) continue
    out.push({ role: 'user', content: t.question }, { role: 'assistant', content: t.answer })
  }
  return out
}

function inputText(v: unknown): string {
  if (v == null) return ''
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return s === '{}' ? '' : s
}

function TraceList({ trace }: { trace: TraceItem[] }) {
  if (trace.length === 0) return null
  const failed = trace.filter((t) => t.result && !t.result.ok).length
  return (
    <details className="border border-border-subtle">
      <summary className="px-2 py-1 cursor-pointer text-[10px] uppercase tracking-wider text-text-secondary select-none">
        TOOL TRACE · {trace.length} call{trace.length === 1 ? '' : 's'}
        {failed > 0 ? ` · ${failed} failed` : ''}
      </summary>
      <ul className="divide-y divide-border-subtle">
        {trace.map((t) => (
          <li key={t.id} className="px-2 py-1 text-[11px] flex flex-col gap-0.5 min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-text-primary">{t.name}</span>
              {t.server && <span className="src-tag">web</span>}
              {!t.result && <span className="text-text-secondary pulse-label">running…</span>}
              {t.result && <Badge tone={t.result.ok ? 'green' : 'red'}>{t.result.ok ? 'ok' : 'error'}</Badge>}
            </div>
            {inputText(t.input) && <span className="text-text-secondary break-all">{inputText(t.input)}</span>}
            {t.result && <span className="text-text-muted break-words">{t.result.summary}</span>}
          </li>
        ))}
      </ul>
    </details>
  )
}

function Citations({ items }: { items: AnalystCitation[] }) {
  if (items.length === 0) return null
  return (
    <div className="flex flex-col gap-1">
      <span className="label">SOURCES</span>
      <ol className="list-decimal pl-5 text-[11px] space-y-0.5">
        {items.map((c) => (
          <li key={c.url} className="break-words">
            <a href={c.url} target="_blank" rel="noopener noreferrer" className="text-info underline-offset-2 hover:underline">
              {c.title || c.url}
            </a>
            <span className="text-text-secondary"> · {new URL(c.url).hostname}</span>
          </li>
        ))}
      </ol>
    </div>
  )
}

function Turn({ t }: { t: TurnState }) {
  return (
    <article className="panel">
      <div className="panel-header gap-2">
        <span className="text-[12px] text-text-primary normal-case tracking-normal break-words min-w-0">{t.question}</span>
        {t.streaming && <span className="text-[10px] text-text-secondary pulse-label shrink-0">STREAMING</span>}
      </div>
      <div className="panel-body flex flex-col gap-2 p-2">
        <TraceList trace={t.trace} />
        {t.answer ? (
          <div className="text-[13px] leading-relaxed text-text-muted whitespace-pre-wrap break-words">{t.answer}</div>
        ) : (
          t.streaming && <SkeletonRows rows={2} />
        )}
        {t.error && <ErrorBlock message={t.error} />}
        <Citations items={t.citations} />
        {t.done && (
          <div className="text-[10px] text-text-secondary tabular flex flex-wrap gap-x-3">
            <span>{t.done.model}</span>
            <span>
              {t.done.usage.input_tokens.toLocaleString()} in · {t.done.usage.output_tokens.toLocaleString()} out
            </span>
            <span>
              {t.done.rounds} tool round{t.done.rounds === 1 ? '' : 's'}
            </span>
            {t.done.stop !== 'end' && <span className="text-amber">stop: {t.done.stop}</span>}
          </div>
        )}
      </div>
    </article>
  )
}

export function Analyst() {
  const [status, setStatus] = useState<AnalystStatus | null>(null)
  const [statusLoading, setStatusLoading] = useState(true)
  const [offline, setOffline] = useState<Offline>(null)
  const [turns, setTurns] = useState<TurnState[]>(sessionTurns)
  const [draft, setDraft] = useState('')
  const abortRef = useRef<AbortController | null>(null)
  const endRef = useRef<HTMLDivElement | null>(null)
  const busy = turns.some((t) => t.streaming)

  useEffect(() => {
    sessionTurns = turns
  }, [turns])

  const probe = useCallback(() => {
    setStatusLoading(true)
    getAnalystStatus()
      .then((s) => {
        setStatus(s)
        setOffline(null)
      })
      .catch((err) => setOffline(offlineFrom(err) ?? { title: 'ANALYST UNAVAILABLE', message: err instanceof Error ? err.message : String(err) }))
      .finally(() => setStatusLoading(false))
  }, [])

  useEffect(() => {
    probe()
    return () => abortRef.current?.abort()
  }, [probe])

  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'end' })
  }, [turns.length])

  const ask = useCallback(
    async (question: string) => {
      const q = question.trim()
      if (!q || busy) return
      const id = nextId++
      const history = toHistory(turns)
      const fresh: TurnState = { id, question: q, answer: '', trace: [], citations: [], error: null, done: null, streaming: true }
      setTurns((ts) => [...ts, fresh])
      setDraft('')
      const ctrl = new AbortController()
      abortRef.current = ctrl
      const update = (fn: (t: TurnState) => TurnState) => setTurns((ts) => ts.map((t) => (t.id === id ? fn(t) : t)))
      try {
        await streamAnalyst(q, history, (e) => update((t) => applyEvent(t, e)), ctrl.signal)
        update((t) => (t.streaming ? { ...t, streaming: false, error: t.error ?? (ctrl.signal.aborted ? 'stopped' : 'stream ended without a done event') } : t))
      } catch (err) {
        const off = offlineFrom(err)
        if (off) setOffline(off)
        update((t) => ({ ...t, streaming: false, error: err instanceof Error ? err.message : String(err) }))
      } finally {
        if (abortRef.current === ctrl) abortRef.current = null
      }
    },
    [busy, turns],
  )

  const stop = () => abortRef.current?.abort()

  return (
    <div className="max-w-[1100px] mx-auto p-3 md:p-[var(--gutter)] flex flex-col gap-3">
      <div className="panel">
        <div className="panel-header flex-wrap gap-2">
          <span className="panel-title">ANALYST</span>
          {status && (
            <span className="flex flex-wrap items-center gap-2 text-[10px] text-text-secondary">
              <span>{status.provider}</span>
              <span className="text-text-muted">{status.model}</span>
              <Badge tone={status.web_search ? 'info' : 'gray'}>{status.web_search ? 'web search' : 'no web search'}</Badge>
            </span>
          )}
        </div>
        <div className="panel-body p-2 flex flex-col gap-2">
          {statusLoading && !status && !offline && <SkeletonRows rows={2} />}
          {offline && <OfflineBlock title={offline.title} message={offline.message} onRetry={probe} />}
          {!offline && status && (
            <>
              <p className="text-[10px] text-text-secondary">
                Read-only market intelligence over briefings, sectors, metrics, markets and engine decisions. It cannot trade or change
                strategies. Not financial advice.
              </p>
              <div className="flex flex-wrap gap-1.5">
                {QUICK_PROMPTS.map((p) => (
                  <Button key={p} tier="ghost" disabled={busy} onClick={() => void ask(p)}>
                    {p}
                  </Button>
                ))}
              </div>
              <form
                className="flex flex-col md:flex-row gap-2"
                onSubmit={(e) => {
                  e.preventDefault()
                  void ask(draft)
                }}
              >
                <label className="sr-only" htmlFor="analyst-q">
                  Question
                </label>
                <textarea
                  id="analyst-q"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      void ask(draft)
                    }
                  }}
                  rows={2}
                  maxLength={4000}
                  placeholder="Ask about the tape, sectors, or the engine's decisions"
                  className="flex-1 min-w-0 bg-elevated border border-border px-2 py-1.5 text-[13px] text-text-primary resize-y focus:outline-none focus:border-text-secondary"
                />
                <div className="flex gap-2 md:flex-col">
                  <Button tier="neutral" type="submit" disabled={busy || !draft.trim()} className="flex-1">
                    {busy ? <span className="pulse-label">ASKING…</span> : 'ASK'}
                  </Button>
                  {busy && (
                    <Button tier="ghost" type="button" onClick={stop} className="flex-1">
                      STOP
                    </Button>
                  )}
                </div>
              </form>
              {status.tools.some((t) => !t.available) && (
                <p className="text-[10px] text-text-secondary">
                  {status.tools
                    .filter((t) => !t.available)
                    .map((t) => `${t.name}: ${t.note ?? 'unavailable'}`)
                    .join(' · ')}
                </p>
              )}
            </>
          )}
        </div>
      </div>

      {turns.length > 0 && (
        <div className="flex items-center justify-between">
          <span className="label">SESSION · {turns.length}</span>
          <Button tier="ghost" disabled={busy} onClick={() => setTurns([])}>
            CLEAR
          </Button>
        </div>
      )}
      {turns.map((t) => (
        <Turn key={t.id} t={t} />
      ))}
      <div ref={endRef} />
    </div>
  )
}
