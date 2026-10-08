import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Badge, Button, ErrorBlock, OfflineBlock, Segmented, SkeletonRows, StatusDot } from '../components'
import { Markdown } from '../components/analyst/Markdown'
import { ModelSelector } from '../components/analyst/ModelSelector'
import { PathCard, PathPending } from '../components/paths/PathCard'
import { ApiError, NetworkError } from '../lib/api'
import {
  getAnalystModels,
  getAnalystStatus,
  streamAnalyst,
  compactSim,
  type AnalystCatalog,
  type AnalystMode,
  type AnalystChoice,
  type AnalystCitation,
  type AnalystStatus,
  type AnalystStreamEvent,
  type AnalystUsage,
  type HistoryTurn,
  type SimResultEvent,
} from '../lib/analyst'

// /analyst — natural-language analyst over the app's data (SPEC.md
// "Analyst"). Read-only market intelligence: it reads briefings, sectors,
// metrics, markets and the engine's decisions, and (on Anthropic models)
// searches the web; it never places, approves or rejects anything.
//
// Layout (DESIGN.md §10.9): a thread panel with a sticky composer, and a
// rail with the prompt library, provider setup status and the tool list.
// Each answer shows the model that wrote it, its reasoning (when the model
// exposes any), a tool timeline, the markdown answer, sources and usage.
//
// State vocabulary (DESIGN.md §6): status probe → SkeletonRows; 503 →
// OfflineBlock "ANALYST NOT CONFIGURED"; 502/network → OfflineBlock
// "ANALYST UNREACHABLE"; per-turn failures → verbatim ErrorBlock under it.

const MODEL_STORAGE_KEY = 'ht_analyst_model'
const SESSION_STORAGE_KEY = 'ht_analyst_session_v2'
const HISTORY_TURNS = 10 // prior turns sent back as context
const STORED_TURNS = 30
const MODE_STORAGE_KEY = 'ht_analyst_mode'
const SIM_SESSION_STORAGE_KEY = 'ht_paths_session_v1'
const SIM_STORED_TURNS = 10 // sim cards carry equity arrays

const PROMPTS: Array<{ group: string; items: string[] }> = [
  { group: 'Briefing', items: ['What changed since the last briefing?', 'Summarize the market state in five bullets, with the numbers.'] },
  { group: 'Markets', items: ['Where is funding most crowded right now?', 'Which perps have the largest open interest, and how is funding on them?'] },
  { group: 'Sectors', items: ['Which sector is rotating, and on what evidence?'] },
  { group: 'Engine', items: ['Explain the last 5 engine decisions.'] },
]

const SIM_PROMPTS: Array<{ group: string; items: string[] }> = [
  { group: 'Perps', items: ["What if I'd put 30% of my stack into SOL perps at 3x and DCA'd ETH weekly since January?"] },
  { group: 'Hedge', items: ['Hedge my ETH with a short BTC position.'] },
  { group: 'Compare', items: ['Compare 60/40 ETH/USDC against 100% BTC since 2023.'] },
  { group: 'Leverage', items: ['Same 50/50 BTC/ETH portfolio at 1x, 2x and 5x since 2024.'] },
  { group: 'DCA', items: ['DCA $200 a month into BTC from a USDC stack since 2022.'] },
]

const MODE_OPTIONS = [
  { value: 'ask', label: 'ASK', title: 'Ask about the market' },
  { value: 'sim', label: 'SIMULATE', short: 'SIM', title: 'Simulate what-if portfolios' },
] as const

const ASK_PLACEHOLDER = "Ask about the tape, sectors, or the engine's decisions"
const SIM_PLACEHOLDER = 'Describe a what-if — "30% of my stack in SOL perps at 3x since January"'

function loadStoredMode(): AnalystMode {
  try {
    return localStorage.getItem(MODE_STORAGE_KEY) === 'sim' ? 'sim' : 'ask'
  } catch {
    return 'ask'
  }
}

// ─── choice persistence ───

function loadStoredChoice(): AnalystChoice | null {
  try {
    const raw = localStorage.getItem(MODEL_STORAGE_KEY)
    if (!raw) return null
    const v = JSON.parse(raw) as Partial<AnalystChoice>
    if (typeof v.provider === 'string' && typeof v.model === 'string') return v as AnalystChoice
  } catch {
    // Corrupt/unavailable storage (private mode, etc.) — fall through to the server default.
  }
  return null
}

function saveChoice(choice: AnalystChoice) {
  try {
    localStorage.setItem(MODEL_STORAGE_KEY, JSON.stringify(choice))
  } catch {
    // Best-effort only.
  }
}

/** Validates a stored/candidate choice against the live catalog: stored → server default → first available. */
export function resolveChoice(catalog: AnalystCatalog, candidate: AnalystChoice | null): AnalystChoice {
  const find = (c: AnalystChoice | null): AnalystChoice | null => {
    if (!c) return null
    const provider = catalog.providers.find((p) => p.id === c.provider && p.available)
    const model = provider?.models.find((m) => m.id === c.model)
    if (!provider || !model) return null
    const effort = model.effort ? (c.effort && (model.efforts ?? [c.effort]).includes(c.effort) ? c.effort : (model.defaultEffort ?? 'medium')) : undefined
    return { provider: provider.id, model: model.id, effort }
  }
  const firstAvailable = catalog.providers.find((p) => p.available && p.models.length > 0)
  return (
    find(candidate) ??
    find({ provider: catalog.default.provider, model: catalog.default.model }) ??
    find(firstAvailable ? { provider: firstAvailable.id, model: firstAvailable.models[0]!.id } : null) ?? {
      // Nothing available: park on the declared default so the pill is stable.
      provider: catalog.default.provider,
      model: catalog.default.model,
    }
  )
}

// ─── turns ───

interface TraceItem {
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

// Session memory across route changes; seeded from localStorage on first load.
const sessionTurns: Record<AnalystMode, TurnState[] | null> = { ask: null, sim: null }
let nextId = 1

function sessionFor(mode: AnalystMode): TurnState[] {
  if (!sessionTurns[mode]) {
    sessionTurns[mode] = loadSession(mode === 'sim' ? SIM_SESSION_STORAGE_KEY : SESSION_STORAGE_KEY)
    nextId = Math.max(nextId, 0, ...sessionTurns[mode]!.map((t) => t.id)) + 1
  }
  return sessionTurns[mode]!
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
    if (!t.answer.trim() || t.streaming) continue
    const trailer =
      mode === 'sim' && t.sims.length
        ? `\n\n[paths]\n${t.sims.flatMap((s) => s.branches.map((b) => JSON.stringify({ name: b.name, config: b.config }))).join('\n')}`
        : ''
    out.push({ role: 'user', content: t.question }, { role: 'assistant', content: t.answer + trailer })
  }
  return out
}

type Offline = { title: string; message: string } | null

function offlineFrom(err: unknown): Offline {
  if (err instanceof ApiError && err.status === 503) {
    return {
      title: 'ANALYST NOT CONFIGURED',
      message:
        'set at least one provider key on the server: ANALYST_ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, XAI_API_KEY, DEEPSEEK_API_KEY, MOONSHOT_API_KEY, DASHSCOPE_API_KEY or OPENROUTER_API_KEY (README "Analyst")',
    }
  }
  if (err instanceof NetworkError || (err instanceof ApiError && err.status === 502)) {
    return { title: 'ANALYST UNREACHABLE', message: 'check your connection and retry' }
  }
  return null
}

function inputText(v: unknown): string {
  if (v == null) return ''
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return s === '{}' ? '' : s
}

const fmtSecs = (ms: number) => (ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`)
const fmtTokens = (n: number) => (n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : n.toLocaleString())

// ─── pieces ───

function Phase({ t }: { t: TurnState }) {
  if (!t.streaming) return null
  const running = t.trace.some((x) => !x.result)
  const label = running ? 'RUNNING TOOLS' : t.answer ? 'WRITING' : t.reasoning ? 'THINKING' : 'WAITING'
  return <span className="text-[10px] text-text-secondary pulse-label shrink-0">{label}…</span>
}

function Reasoning({ t }: { t: TurnState }) {
  if (!t.reasoning) return null
  const live = t.streaming && !t.answer
  return (
    <details className="border-l-2 border-border pl-2" open={live || undefined}>
      <summary className="cursor-pointer select-none text-[10px] uppercase tracking-wider text-text-secondary">
        Reasoning · {t.reasoning.length.toLocaleString()} chars
      </summary>
      <div className="mt-1 max-h-[240px] overflow-y-auto text-[12px] leading-relaxed text-text-secondary whitespace-pre-wrap break-words">
        {t.reasoning}
      </div>
    </details>
  )
}

function Timeline({ trace }: { trace: TraceItem[] }) {
  if (trace.length === 0) return null
  const failed = trace.filter((t) => t.result && !t.result.ok).length
  return (
    <details className="group">
      <summary className="cursor-pointer select-none list-none flex flex-wrap items-center gap-1">
        <span className="text-[10px] uppercase tracking-wider text-text-secondary mr-1">
          Tools · {trace.length}
          {failed > 0 ? ` · ${failed} failed` : ''}
        </span>
        {trace.map((t) => (
          <span
            key={t.id}
            className={`inline-flex items-center gap-1 h-[18px] px-1.5 border text-[10px] ${
              !t.result ? 'border-border text-text-secondary pulse-label' : t.result.ok ? 'border-border-subtle text-text-muted' : 'border-red text-red-text'
            }`}
          >
            {t.server && <span className="src-tag">web</span>}
            {t.name}
          </span>
        ))}
      </summary>
      <ul className="mt-1 border border-border-subtle divide-y divide-border-subtle">
        {trace.map((t) => (
          <li key={t.id} className="px-2 py-1 text-[11px] flex flex-col gap-0.5 min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-text-primary">{t.name}</span>
              {t.result ? <Badge tone={t.result.ok ? 'green' : 'red'}>{t.result.ok ? 'ok' : 'error'}</Badge> : <span className="text-text-secondary pulse-label">running…</span>}
            </div>
            {inputText(t.input) && <span className="text-text-secondary break-all">{inputText(t.input)}</span>}
            {t.result && <span className="text-text-muted break-words">{t.result.summary}</span>}
          </li>
        ))}
      </ul>
    </details>
  )
}

function Sources({ items }: { items: AnalystCitation[] }) {
  if (items.length === 0) return null
  return (
    <div className="flex flex-col gap-1">
      <span className="label">SOURCES</span>
      <ol className="list-decimal pl-5 text-[11px] space-y-0.5">
        {items.map((c) => {
          let host = ''
          try {
            host = new URL(c.url).hostname
          } catch {
            // A malformed URL still lists, just without its host.
          }
          return (
            <li key={c.url} className="break-words">
              <a href={c.url} target="_blank" rel="noopener noreferrer" className="text-info underline-offset-2 hover:underline">
                {c.title || c.url}
              </a>
              {host && <span className="text-text-secondary"> · {host}</span>}
            </li>
          )
        })}
      </ol>
    </div>
  )
}

function Turn({
  t,
  onRetry,
  busy,
  labelFor,
  onSaved,
  onFork,
}: {
  t: TurnState
  onRetry: (q: string) => void
  busy: boolean
  labelFor: (provider: string) => string
  onSaved: (turnId: number, key: string, branchId: string) => void
  onFork: (name: string) => void
}) {
  const [copied, setCopied] = useState(false)
  const who = t.done ?? t.asked
  const copy = () => {
    void navigator.clipboard?.writeText(t.answer).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    })
  }
  return (
    <article className="flex flex-col gap-2">
      <div className="flex justify-end">
        <div className="max-w-[88%] md:max-w-[75%] bg-elevated border border-border px-3 py-2 text-[13px] text-text-primary whitespace-pre-wrap break-words">
          {t.question}
        </div>
      </div>
      <div className="flex flex-col gap-2 min-w-0">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-text-secondary">
          <StatusDot status={t.error && !t.answer ? 'down' : t.streaming ? 'degraded' : 'ok'} />
          {who && (
            <span className="uppercase tracking-wider">
              {t.done?.label ?? labelFor(who.provider)} · <span className="normal-case text-text-muted">{who.model}</span>
              {who.effort ? ` · ${who.effort}` : ''}
            </span>
          )}
          <Phase t={t} />
        </div>
        <Reasoning t={t} />
        <Timeline trace={t.trace} />
        {t.sims.map((sim) => (
          <PathCard key={sim.id} sim={sim} saved={t.saved} onSaved={(key, id) => onSaved(t.id, key, id)} onFork={onFork} />
        ))}
        {t.streaming &&
          t.trace
            .filter((x) => x.name === 'simulate_paths' && !x.result && !t.sims.some((s) => s.id === x.id))
            .map((x) => <PathPending key={x.id} input={x.input} />)}
        {t.answer ? <Markdown text={t.answer} /> : t.streaming && !t.reasoning && t.trace.length === 0 && <SkeletonRows rows={2} />}
        {t.error && <ErrorBlock message={t.error} />}
        <Sources items={t.citations} />
        {!t.streaming && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-text-secondary tabular border-t border-border-subtle pt-1.5">
            {t.done && (
              <>
                <span>
                  {fmtTokens(t.done.usage.input_tokens)} in · {fmtTokens(t.done.usage.output_tokens)} out
                </span>
                <span>
                  {t.done.rounds} tool round{t.done.rounds === 1 ? '' : 's'}
                </span>
              </>
            )}
            {t.finishedAt && <span>{fmtSecs(t.finishedAt - t.startedAt)}</span>}
            {t.done && t.done.stop !== 'end' && <span className="text-amber">stop: {t.done.stop}</span>}
            <span className="flex-1" />
            {t.answer && (
              <button type="button" onClick={copy} className="uppercase tracking-wider hover:text-text-primary">
                {copied ? 'Copied' : 'Copy'}
              </button>
            )}
            <button type="button" disabled={busy} onClick={() => onRetry(t.question)} className="uppercase tracking-wider hover:text-text-primary disabled:text-text-disabled">
              Ask again
            </button>
          </div>
        )}
      </div>
    </article>
  )
}

function Composer({ draft, setDraft, busy, onAsk, onStop, disabled, mode }: { draft: string; setDraft: (s: string) => void; busy: boolean; onAsk: () => void; onStop: () => void; disabled: boolean; mode: AnalystMode }) {
  const ref = useRef<HTMLTextAreaElement | null>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }, [draft])
  return (
    <form
      // Clears the fixed mobile tab bar (AppShell: 56px + safe area) below md.
      className="sticky bottom-[calc(56px_+_env(safe-area-inset-bottom))] md:bottom-0 z-10 border-t border-border bg-panel p-2 flex flex-col gap-1"
      onSubmit={(e) => {
        e.preventDefault()
        onAsk()
      }}
    >
      <div className="flex gap-2 items-end">
        <label className="sr-only" htmlFor="analyst-q">
          Question
        </label>
        <textarea
          id="analyst-q"
          ref={ref}
          value={draft}
          disabled={disabled}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              onAsk()
            }
          }}
          rows={1}
          maxLength={4000}
          placeholder={mode === 'sim' ? SIM_PLACEHOLDER : ASK_PLACEHOLDER}
          className="flex-1 min-w-0 bg-input border border-border px-2 py-1.5 text-[13px] text-text-primary resize-none focus:outline-none focus:border-text-secondary disabled:opacity-50"
        />
        {busy ? (
          <Button tier="ghost" type="button" onClick={onStop}>
            STOP
          </Button>
        ) : (
          <Button tier="neutral" type="submit" disabled={disabled || !draft.trim()}>
            {mode === 'sim' ? 'SIMULATE' : 'ASK'}
          </Button>
        )}
      </div>
      <div className="flex justify-between text-[10px] text-text-secondary">
        <span>Enter to send · Shift+Enter for a new line</span>
        {draft.length > 3000 && <span className="tabular">{draft.length}/4000</span>}
      </div>
    </form>
  )
}

function EmptyThread({ onAsk, disabled, mode }: { onAsk: (q: string) => void; disabled: boolean; mode: AnalystMode }) {
  const sim = mode === 'sim'
  return (
    <div className="flex flex-col gap-3 py-6 md:py-10">
      <div className="flex flex-col gap-1">
        <span className="text-[16px] text-text-primary">{sim ? 'Simulate a path' : 'Ask the analyst'}</span>
        <span className="text-[11px] text-text-secondary max-w-[560px]">
          {sim
            ? 'Describe a what-if in plain words — sizes, leverage, shorts, DCA, a start date. It becomes one to four branches, backtested on daily candles against HODL BTC and USDC, with every assumption it made listed on the card. Historical simulation, not advice.'
            : "It reads the briefing and its history, the sector map, collected metrics, the live Hyperliquid universe and the engine's decisions, then answers with its sources. Read-only, and not financial advice."}
        </span>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {(sim ? SIM_PROMPTS : PROMPTS).flatMap((g) => g.items.map((q) => ({ g: g.group, q }))).map(({ g, q }) => (
          <button
            key={q}
            type="button"
            disabled={disabled}
            onClick={() => onAsk(q)}
            className="text-left border border-border bg-elevated hover:bg-hover px-3 py-2 flex flex-col gap-0.5 disabled:opacity-50"
          >
            <span className="text-[10px] uppercase tracking-wider text-text-secondary">{g}</span>
            <span className="text-[12px] text-text-primary">{q}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

function Rail({
  catalog,
  choice,
  onPick,
  status,
  busy,
  onAsk,
  mode,
}: {
  catalog: AnalystCatalog | null
  choice: AnalystChoice | null
  onPick: (c: AnalystChoice) => void
  status: AnalystStatus | null
  busy: boolean
  onAsk: (q: string) => void
  mode: AnalystMode
}) {
  return (
    <aside className="flex flex-col gap-3 lg:sticky lg:top-3">
      <div className="panel">
        <div className="panel-header">
          <span className="panel-title">PROMPTS</span>
        </div>
        <div className="panel-body p-2 flex flex-col gap-2">
          {(mode === 'sim' ? SIM_PROMPTS : PROMPTS).map((g) => (
            <div key={g.group} className="flex flex-col gap-1">
              <span className="text-[10px] uppercase tracking-wider text-text-secondary">{g.group}</span>
              {g.items.map((q) => (
                <button key={q} type="button" disabled={busy} onClick={() => onAsk(q)} className="text-left text-[11px] text-text-muted hover:text-text-primary disabled:text-text-disabled">
                  {q}
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>

      <div className="panel">
        <div className="panel-header">
          <span className="panel-title">PROVIDERS</span>
          {catalog && (
            <span className="text-[10px] text-text-secondary tabular">
              {catalog.providers.filter((p) => p.available).length}/{catalog.providers.length} ready
            </span>
          )}
        </div>
        <ul className="divide-y divide-border-subtle">
          {(catalog?.providers ?? []).map((p) => {
            const active = choice?.provider === p.id
            const first = p.models[0]
            return (
              <li key={p.id}>
                <button
                  type="button"
                  disabled={!p.available || !first}
                  onClick={() => first && onPick(resolveChoice(catalog!, active ? choice : { provider: p.id, model: first.id }))}
                  className={`w-full text-left px-2 py-1.5 flex items-start gap-2 ${active ? 'bg-selected' : 'hover:bg-hover'} disabled:hover:bg-transparent disabled:cursor-default`}
                >
                  <span className="pt-1">
                    <StatusDot status={p.available ? 'ok' : 'down'} />
                  </span>
                  <span className="flex-1 min-w-0 flex flex-col">
                    <span className={`text-[11px] ${p.available ? 'text-text-primary' : 'text-text-secondary'}`}>
                      {p.label}
                      {p.webSearch && <span className="src-tag ml-1.5">web</span>}
                    </span>
                    <span className="text-[10px] text-text-secondary break-words">{p.available ? p.blurb : p.reason}</span>
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      </div>

      {status && (
        <details className="panel">
          <summary className="panel-header cursor-pointer select-none">
            <span className="panel-title">TOOLS · {status.tools.filter((t) => t.available).length}</span>
          </summary>
          <ul className="px-2 py-1.5 flex flex-col gap-0.5 text-[11px]">
            {status.tools.map((t) => (
              <li key={t.name} className={t.available ? 'text-text-muted' : 'text-text-disabled'}>
                {t.name}
                {t.note && <span className="text-text-secondary"> — {t.note}</span>}
              </li>
            ))}
          </ul>
        </details>
      )}

      <p className="text-[10px] text-text-secondary px-1">
        {mode === 'sim'
          ? "Historical simulation on daily candles. Perp legs ignore funding, fees and slippage and liquidate at 100% margin loss on the day's low or high. Saving creates a branch; nothing is traded. Not financial advice."
          : 'Read-only market intelligence. It cannot trade or change strategies; Jev and the operator do that on the engine pages. Not financial advice.'}
      </p>
    </aside>
  )
}

// ─── page ───

export function Analyst() {
  const [status, setStatus] = useState<AnalystStatus | null>(null)
  const [statusLoading, setStatusLoading] = useState(true)
  const [offline, setOffline] = useState<Offline>(null)
  const [mode, setModeState] = useState<AnalystMode>(loadStoredMode)
  const [threads, setThreads] = useState<Record<AnalystMode, TurnState[]>>(() => ({ ask: sessionFor('ask'), sim: sessionFor('sim') }))
  const turns = threads[mode]
  const setTurnsFor = useCallback((m: AnalystMode, fn: (ts: TurnState[]) => TurnState[]) => setThreads((th) => ({ ...th, [m]: fn(th[m]) })), [])
  const [draft, setDraft] = useState('')
  const [catalog, setCatalog] = useState<AnalystCatalog | null>(null)
  const [catalogError, setCatalogError] = useState<string | null>(null)
  const [choice, setChoice] = useState<AnalystChoice | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const endRef = useRef<HTMLDivElement | null>(null)
  const busy = turns.some((t) => t.streaming)

  useEffect(() => {
    sessionTurns.ask = threads.ask
    sessionTurns.sim = threads.sim
    if (!busy) {
      saveSession(SESSION_STORAGE_KEY, STORED_TURNS, threads.ask)
      saveSession(SIM_SESSION_STORAGE_KEY, SIM_STORED_TURNS, threads.sim)
    }
  }, [threads, busy])

  const setMode = (m: AnalystMode) => {
    setModeState(m)
    try {
      localStorage.setItem(MODE_STORAGE_KEY, m)
    } catch {
      // Best-effort only.
    }
  }

  const fork = (name: string) => {
    const prefix = `Fork "${name}": `
    setDraft((d) => (d.startsWith(prefix) ? d : prefix + d))
    requestAnimationFrame(() => {
      const el = document.getElementById('analyst-q') as HTMLTextAreaElement | null
      el?.focus()
      el?.setSelectionRange(el.value.length, el.value.length)
    })
  }

  const onSaved = (turnId: number, key: string, branchId: string) =>
    setTurnsFor(mode, (ts) => ts.map((t) => (t.id === turnId ? { ...t, saved: { ...t.saved, [key]: branchId } } : t)))

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

  // The stored choice is checked against the catalog every time it (re)loads,
  // so a retired model or reconfigured provider never leaves the picker stuck.
  const loadCatalog = useCallback(() => {
    setCatalogError(null)
    getAnalystModels()
      .then((cat) => {
        setCatalog(cat)
        const resolved = resolveChoice(cat, loadStoredChoice())
        setChoice(resolved)
        saveChoice(resolved)
      })
      .catch((err) => setCatalogError(err instanceof Error ? err.message : String(err)))
  }, [])

  const onModelChange = useCallback((next: AnalystChoice) => {
    setChoice(next)
    saveChoice(next)
  }, [])

  useEffect(() => {
    probe()
    loadCatalog()
    return () => abortRef.current?.abort()
  }, [probe, loadCatalog])

  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'end' })
  }, [turns.length])

  const labelFor = useMemo(() => {
    const m = new Map((catalog?.providers ?? []).map((p) => [p.id, p.label]))
    return (id: string) => m.get(id) ?? id
  }, [catalog])

  const ask = useCallback(
    async (question: string) => {
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
      setDraft('')
      const ctrl = new AbortController()
      abortRef.current = ctrl
      const update = (fn: (t: TurnState) => TurnState) => setTurnsFor(m, (ts) => ts.map((t) => (t.id === id ? fn(t) : t)))
      try {
        // choice is undefined until the catalog loads — the server then uses its own default.
        await streamAnalyst(q, history, (e) => update((t) => applyEvent(t, e)), ctrl.signal, choice ?? undefined, m)
        update((t) =>
          t.streaming
            ? { ...t, streaming: false, finishedAt: Date.now(), error: t.error ?? (ctrl.signal.aborted ? 'stopped' : 'stream ended without a done event') }
            : t,
        )
      } catch (err) {
        const off = offlineFrom(err)
        if (off) setOffline(off)
        update((t) => ({ ...t, streaming: false, finishedAt: Date.now(), error: err instanceof Error ? err.message : String(err) }))
      } finally {
        if (abortRef.current === ctrl) abortRef.current = null
      }
    },
    [busy, turns, choice, mode, setTurnsFor],
  )

  const stop = () => abortRef.current?.abort()
  const selectedProvider = catalog?.providers.find((p) => p.id === choice?.provider && p.available)
  const ready = !!status && !offline

  return (
    <div className="max-w-[1440px] mx-auto p-3 md:p-[var(--gutter)] grid gap-3 lg:grid-cols-[minmax(0,1fr)_300px] items-start">
      <section className="panel flex flex-col min-w-0 lg:min-h-[calc(100dvh_-_120px)]!">
        <div className="panel-header flex-col items-start justify-start gap-2 md:flex-row md:items-center md:justify-between">
          <span className="flex items-center gap-2" title={busy ? 'wait for the answer or STOP' : undefined}>
            <span className="panel-title">ANALYST</span>
            <Segmented
              options={MODE_OPTIONS}
              value={mode}
              onChange={setMode}
              label="analyst mode"
              size="sm"
              disabled={busy}
            />
          </span>
          <div className="flex flex-col items-start gap-2 w-full md:w-auto md:flex-row md:items-center">
            {catalogError ? (
              <button type="button" onClick={loadCatalog} className="text-[10px] uppercase tracking-wider text-red-text underline underline-offset-2">
                model list unreachable — retry
              </button>
            ) : (
              <ModelSelector catalog={catalog} value={choice} onChange={onModelChange} />
            )}
            {selectedProvider && (
              <span className="flex items-center gap-1.5">
                <Badge tone={selectedProvider.webSearch ? 'info' : 'gray'}>{selectedProvider.webSearch ? 'web search' : 'app data only'}</Badge>
                {turns.length > 0 && (
                  <Button tier="ghost" disabled={busy} onClick={() => setTurnsFor(mode, () => [])}>
                    CLEAR
                  </Button>
                )}
              </span>
            )}
          </div>
        </div>

        <div className="flex-1 p-3 md:p-4 flex flex-col gap-6">
          {statusLoading && !status && !offline && <SkeletonRows rows={3} />}
          {offline && <OfflineBlock title={offline.title} message={offline.message} onRetry={probe} />}
          {!offline && turns.length === 0 && status && <EmptyThread onAsk={(q) => void ask(q)} disabled={busy} mode={mode} />}
          {turns.map((t) => (
            <Turn key={t.id} t={t} busy={busy} onRetry={(q) => void ask(q)} labelFor={labelFor} onSaved={onSaved} onFork={fork} />
          ))}
          <div ref={endRef} />
        </div>

        <Composer draft={draft} setDraft={setDraft} busy={busy} onAsk={() => void ask(draft)} onStop={stop} disabled={!ready} mode={mode} />
      </section>

      <Rail catalog={catalog} choice={choice} onPick={onModelChange} status={status} busy={busy || !ready} onAsk={(q) => void ask(q)} mode={mode} />
    </div>
  )
}
