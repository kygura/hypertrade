import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { AsyncBody, Badge, Button, ConfirmDialog, ErrorBlock, HowToRead, OfflineBlock, Panel, PanelBody, PanelHeader, Segmented, SkeletonRows, DataTable, type Column } from '../components'
import { Markdown } from '../components/analyst/Markdown'
import { KillSwitchDialog } from '../components/KillSwitchDialog'
import { api, ApiError, NetworkError } from '../lib/api'
import { usePoll } from '../lib/poll'
import { useDeskKill } from '../lib/useDeskKill'
import {
  deskTakeaway,
  emptyRun,
  fmtPx,
  fmtUsd,
  reduceRun,
  streamDesk,
  type AgentView,
  type AlertRow,
  type DeskEvent,
  type DeskStatus,
  type ExitProposal,
  type OperatorOrderRecord,
  type Portfolio,
  type ProposalRecord,
  type RunRow,
  type RunView,
  type TradeProposal,
} from '../lib/desk'
import type { Term } from '../components'

// /desk — the agentic portfolio desk (docs/SPEC.md "Desk"). Ask the team a
// question and watch the PM fan out to specialists; approve or reject what
// the governor queued; see the paper book, alerts and past runs. Entries
// only reach the book through the server's governor; this page never sizes.

type Turn = { role: 'user' | 'assistant'; content: string }

const STATUS_TONE: Record<string, 'green' | 'red' | 'amber' | 'info' | 'gray'> = {
  executed: 'green',
  pending: 'amber',
  blocked: 'red',
  failed: 'red',
  rejected: 'gray',
  expired: 'gray',
}

const SUGGESTIONS = [
  'Is the current BTC rally a bull trap or driven by genuine flows? Does macro, the state of the world and fiscal policy support it?',
  'Which sector rotation on Hyperliquid looks funded by new money rather than short covering?',
  'Review the book: anything to cut or tighten given current flows and the macro calendar?',
]

// Equity, proposals and alerts change without the operator doing anything (the governor queues, the
// book marks to market): refetch on the same 30 s cadence as the Cockpit's desk strip. usePoll pauses
// while the tab is hidden and updates in place. The SSE ask lane (streamDesk) is not polled.
const DESK_POLL_MS = 30_000

/** usePoll on a desk GET, in the `offline: boolean` shape the panels take. */
function useDeskPoll<T>(path: string) {
  const s = usePoll(() => api.get<T>(path), [path], { intervalMs: DESK_POLL_MS })
  return { ...s, offline: s.offline != null }
}

export function Desk() {
  const status = useDeskPoll<DeskStatus>('/desk/status')
  const portfolio = useDeskPoll<Portfolio>('/desk/portfolio')
  const proposals = useDeskPoll<{ proposals: ProposalRecord[] }>('/desk/proposals?limit=30')
  const alerts = useDeskPoll<{ alerts: AlertRow[] }>('/desk/alerts?limit=30')
  const runs = useDeskPoll<{ runs: RunRow[] }>('/desk/runs?limit=15')

  const refreshBook = useCallback(() => {
    portfolio.refetch()
    proposals.refetch()
    alerts.refetch()
    runs.refetch()
  }, [portfolio, proposals, alerts, runs])

  if (status.offline) return <OfflineBlock onRetry={status.refetch} />
  if (status.error) return <ErrorBlock message={status.error} onRetry={status.refetch} />

  const limits = status.data?.limits
  const takeaway = portfolio.data ? deskTakeaway(portfolio.data.desk, proposals.data?.proposals, limits) : null

  return (
    <div className="flex flex-col gap-3 p-3 min-w-0">
      <HeaderStrip status={status.data} portfolio={portfolio.data} onChange={() => (status.refetch(), refreshBook())} />
      <div className="flex flex-col gap-1 px-1 min-w-0">
        {takeaway && (
          <p className="m-0 text-md text-text-primary tabular" data-testid="desk-takeaway">
            {takeaway}
          </p>
        )}
        <HowToRead terms={deskTerms(limits)}>
          The desk is a team of model agents that researches and proposes trades on a practice account. Every entry is sized and checked by fixed risk rules (the
          governor) before it can fill. Read the line above for how much of each limit the book uses now.
        </HowToRead>
      </div>
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-3 min-w-0">
        <div className="xl:col-span-2 flex flex-col gap-3 min-w-0">
          <AskPanel status={status.data} onRunFinished={refreshBook} />
          <RunsPanel schedule={status.data?.schedule} runs={runs.data?.runs} loading={runs.loading} error={runs.error} offline={runs.offline} onRetry={runs.refetch} />
        </div>
        <div className="flex flex-col gap-3 min-w-0">
          <ApprovalsPanel limits={limits} proposals={proposals.data?.proposals} loading={proposals.loading} error={proposals.error} offline={proposals.offline} onRetry={proposals.refetch} onChange={refreshBook} />
          <PositionsPanel portfolio={portfolio.data} loading={portfolio.loading} onChange={refreshBook} />
          <AlertsPanel alerts={alerts.data?.alerts} loading={alerts.loading} error={alerts.error} offline={alerts.offline} onRetry={alerts.refetch} />
        </div>
      </div>
    </div>
  )
}

const lim = (limits: DeskStatus['limits'] | undefined, key: string, unit = '') => (limits?.[key] != null ? `${limits[key]}${unit}` : 'not loaded')

/** Header strip and governor limits, with the limit values the server reports. */
function deskTerms(limits: DeskStatus['limits'] | undefined): Term[] {
  return [
    ['PAPER / HL-TESTNET', 'Where orders go. Paper is a simulated book filled at the live Hyperliquid mark plus slippage and the taker fee. HL-TESTNET sends real orders to the Hyperliquid test network. Mainnet is not supported.'],
    ['EQUITY', 'Account value in USD: cash plus unrealized profit or loss on open positions.'],
    ['DAY PNL', 'Change in equity since 00:00 UTC, realized plus unrealized, in USD.'],
    ['MODEL', 'The language model that runs the portfolio manager, then the one for the specialists if it differs.'],
    ['APPROVE EACH / AUTO', 'Approve each: an entry that passes the governor waits for your approval. Auto: it fills at once. Exits never wait, they only reduce risk.'],
    ['4H … 48H / OFF', 'How often the team runs a full review of the book on its own. OFF stops scheduled reviews; price and risk alerts can still start one.'],
    ['ENV', 'The review interval comes from the server configuration. Saving a value here replaces it.'],
    ['KILL / RESUME', 'Kill blocks every new entry until you resume. Exits stay allowed.'],
    ['Governor', 'The fixed rules every entry must pass. It computes size itself from equity, the stop and the live mark, and checks again at fill time.'],
    ['Risk per trade', `Loss if the stop fills, as a share of equity. Limit ${lim(limits, 'maxRiskPct', '%')}; a larger request is cut to it.`],
    ['Open stop risk', `Sum over open positions of the loss from mark to stop (the whole notional when a position has no stop). Limit ${lim(limits, 'maxOpenRiskPct', '%')} of equity, including the new trade.`],
    ['Gross notional', `Sum of position sizes times mark, in USD. Limit ${lim(limits, 'maxGrossLeverage', 'x')} equity in total and ${lim(limits, 'maxCoinLeverage', 'x')} equity in one coin.`],
    ['Positions', `At most ${lim(limits, 'maxPositions')} open at once, one per coin.`],
    ['Stop distance', `Distance from mark to stop. Allowed range ${lim(limits, 'minStopPct', '%')} to ${lim(limits, 'maxStopPct', '%')}.`],
    ['Day loss', `When equity is down ${lim(limits, 'dailyLossLimitPct', '%')} since 00:00 UTC, new entries are blocked until the next UTC day.`],
  ]
}

function proposalTerms(limits: DeskStatus['limits'] | undefined): Term[] {
  return [
    ['PENDING', 'Passed the governor and waits for your decision. It expires at the time shown if you do nothing.'],
    ['EXECUTED', 'Filled on the desk venue.'],
    ['BLOCKED', 'The governor refused it, on submission or when it re-checked at fill time. The lines marked ✕ are the reasons.'],
    ['FAILED', 'It passed the governor but the venue did not fill it. The venue error is shown.'],
    ['REJECTED / EXPIRED', 'You rejected it, or it was not approved before its expiry time.'],
    ['LONG / SHORT / EXIT 50%', 'An entry and its direction, or an exit and the share of the position it closes.'],
    ['mark', 'Venue mark price when the governor last checked.'],
    ['stop (x%)', 'Stop price, and its distance from the mark in percent.'],
    ['R:R', `Reward to risk at the current mark: distance to target divided by distance to stop. Entries under ${lim(limits, 'minRewardRisk')} are blocked. n/a means no target was given.`],
    ['risk', 'USD lost if the stop fills at its price: notional times stop distance. Fees and slippage are extra.'],
    ['size', 'Order size in coins, with its USD notional. The governor sets it from the risk and the stop distance, then caps it by the leverage limits.'],
    ['confidence', `The proposing agent's own rating: low, medium or high. Entries below ${lim(limits, 'minConfidence')} are blocked.`],
    ['asked x% risk', 'Share of equity the agent asked to risk. The size shown is what the governor allowed, which can be smaller.'],
    ['✕ / ⚠', '✕ is a reason the entry is blocked. ⚠ is a warning: something was reduced or could not be checked, and the entry can still fill.'],
    ['[source]', 'The data source an agent cites for each evidence line.'],
  ]
}

const BOOK_TERMS: Term[] = [
  ['▲ / ▼', 'Long or short.'],
  ['SIZE', 'Position size in coins.'],
  ['ENTRY', 'Average entry price.'],
  ['STOP', 'Stop price. A dash means the position has no stop.'],
  ['UPNL', 'Unrealized profit or loss at the current mark, in USD, before exit fees.'],
  ['Amount beside the title', 'That account\'s equity in USD.'],
  ['WATCHED HYPERLIQUID ACCOUNT', 'A real Hyperliquid account the desk reads but never trades. It is shown for context and cannot be closed from here.'],
  ['RECENT FILLS', 'Latest desk fills: time, buy or sell, size, coin, fill price, why it filled (entry, stop, target or an exit reason) and the realized profit or loss in USD before fees.'],
]

const ALERT_TERMS: Term[] = [
  ['INFO / WARN / CRITICAL', 'How urgent the desk rated it. Critical is used for a position without a stop, the daily loss limit and the kill switch.'],
  ['x% in 1h / 4h', 'A watched or held coin moved at least 4% in 1 hour (BTC 2.5%), or at least 8% in 4 hours (BTC 5%).'],
  ['funding x% APR', 'Hourly funding, annualized, is at or above 50% or at or below −30%.'],
  ['OI x% in 4h', 'Open interest changed by 10% or more over about 4 hours.'],
  ['near its stop', 'A quarter or less of the distance from entry to stop is left.'],
  ['Breadth shock', 'The median of the 50 largest perps moved 6% or more in 24 hours and at most 15%, or at least 85%, of them rose.'],
  ['Approve? / Blocked', 'A proposal waits for you, or the governor refused one. The reasons are in the text.'],
  ['stopped out / hit target', 'A position closed at its stop or target, with the fill and its profit or loss.'],
  ['Repeat rule', 'The same market condition alerts at most once every 3 hours.'],
]

function HeaderStrip({ status, portfolio, onChange }: { status: DeskStatus | null; portfolio: Portfolio | null; onChange: () => void }) {
  const kill = status?.killSwitch.on ?? false
  const killSwitch = useDeskKill(kill, onChange)
  const desk = portfolio?.desk

  const setApproval = async (approval: 'manual' | 'auto') => {
    await api.put('/desk/approval', { approval }).catch(() => undefined)
    onChange()
  }
  return (
    <Panel>
      <PanelBody className="flex flex-wrap items-center gap-x-5 gap-y-2 p-3">
        <div className="flex items-center gap-2">
          <span className="text-base text-text-primary font-display tracking-wider">DESK</span>
          <Badge tone={status?.live ? 'amber' : 'info'}>{(status?.venue ?? 'paper').toUpperCase()}</Badge>
          {kill && <Badge tone="red">KILL SWITCH</Badge>}
        </div>
        <Stat label="EQUITY" title="cash plus unrealized profit or loss, in USD" value={desk ? fmtUsd(desk.equityUsd) : '—'} />
        <Stat label="DAY PNL" title="change in equity since 00:00 UTC, realized plus unrealized" value={desk ? fmtUsd(desk.dayPnlUsd) : '—'} tone={desk ? (desk.dayPnlUsd >= 0 ? 'text-green' : 'text-red-text') : undefined} />
        <Stat label="POSITIONS" value={desk ? String(desk.positions.length) : '—'} />
        <Stat label="MODEL" title="model running the portfolio manager / the specialists" value={status?.model ? `${status.model.pm}${status.model.scouts !== status.model.pm ? ` / ${status.model.scouts}` : ''}` : 'not configured'} />
        <div className="flex items-center gap-2 ml-auto">
          {status && (
            <Segmented
              label="approval"
              size="sm"
              value={status.approval}
              onChange={(v) => void setApproval(v)}
              options={[
                { value: 'manual', label: 'APPROVE EACH', short: 'MANUAL', title: 'Every entry waits for your approval' },
                { value: 'auto', label: 'AUTO', title: 'Entries the governor passes execute immediately' },
              ]}
            />
          )}
          <ReviewIntervalControl status={status} onChange={onChange} />
          <Button tier="danger" onClick={killSwitch.arm} disabled={!status}>
            {kill ? 'RESUME' : 'KILL'}
          </Button>
        </div>
      </PanelBody>
      {status?.live && (
        <div className="px-3 pb-2 text-xs text-amber break-all">
          Live orders on Hyperliquid testnet for {status.venueAccount}. Stops and targets rest on the exchange.
        </div>
      )}
      {status?.venueNote && <div className="px-3 pb-2 text-xs text-red-text">{status.venueNote}.</div>}
      {killSwitch.open && (
        <KillSwitchDialog killOn={kill} busy={killSwitch.busy} error={killSwitch.error} onConfirm={() => void killSwitch.confirm()} onCancel={killSwitch.cancel} />
      )}
    </Panel>
  )
}

const REVIEW_HOURS_OPTIONS = [4, 8, 12, 24, 48, 0] as const

function ReviewIntervalControl({ status, onChange }: { status: DeskStatus | null; onChange: () => void }) {
  const [pending, setPending] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const effective = status?.schedule.reviewEveryHours ?? null
  const value = pending ?? effective ?? 0
  const dirty = pending != null && pending !== effective

  const save = async () => {
    setBusy(true)
    setErr(null)
    try {
      await api.put('/desk/settings', { reviewEveryHours: value })
      setPending(null)
      onChange()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex items-center gap-1.5">
      <Segmented
        label="scheduled review interval"
        size="sm"
        value={value}
        onChange={setPending}
        disabled={!status}
        options={REVIEW_HOURS_OPTIONS.map((h) => ({ value: h, label: h === 0 ? 'OFF' : `${h}H`, title: h === 0 ? 'Scheduled reviews off' : `Full review every ${h}h` }))}
      />
      {status && status.schedule.reviewEveryHoursSource === 'env' && !dirty && (
        <span title="interval set in the server configuration; saving a value here replaces it">
          <Badge tone="gray">ENV</Badge>
        </span>
      )}
      {dirty && (
        <Button tier="ghost" onClick={() => void save()} disabled={busy}>
          SAVE
        </Button>
      )}
      {err && <span className="text-xs text-red-text">{err}</span>}
    </div>
  )
}

function Stat({ label, value, tone, title }: { label: string; value: string; tone?: string; title?: string }) {
  return (
    <div className="flex flex-col min-w-0" title={title}>
      <span className="label text-2xs">{label}</span>
      <span className={`text-md tabular truncate ${tone ?? 'text-text-primary'}`}>{value}</span>
    </div>
  )
}

function AskPanel({ status, onRunFinished }: { status: DeskStatus | null; onRunFinished: () => void }) {
  const [question, setQuestion] = useState('')
  const [act, setAct] = useState(false)
  const [run, setRun] = useState<RunView | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [history, setHistory] = useState<Turn[]>([])
  const abort = useRef<AbortController | null>(null)

  useEffect(() => () => abort.current?.abort(), [])

  const start = async (path: '/desk/ask' | '/desk/review', body: unknown, q: string) => {
    abort.current?.abort()
    const ctrl = new AbortController()
    abort.current = ctrl
    setBusy(true)
    setErr(null)
    let view = emptyRun(path === '/desk/ask' ? 'ask' : 'cycle', q)
    setRun(view)
    try {
      await streamDesk(
        path,
        body,
        (e: DeskEvent) => {
          view = reduceRun(view, e)
          setRun(view)
        },
        ctrl.signal,
      )
      const answer = view.agents.find((a) => a.id === 'pm')?.text
      if (path === '/desk/ask' && answer) setHistory((h) => [...h, { role: 'user' as const, content: q }, { role: 'assistant' as const, content: answer }].slice(-12))
    } catch (e) {
      setErr(e instanceof ApiError || e instanceof NetworkError ? e.message : 'run failed')
    } finally {
      setBusy(false)
      onRunFinished()
    }
  }

  const ask = (q = question) => {
    if (!q.trim() || busy) return
    setQuestion('')
    void start('/desk/ask', { question: q.trim(), history, act }, q.trim())
  }

  return (
    <Panel>
      <PanelHeader title="ASK THE DESK">
        {history.length > 0 && (
          <Button tier="ghost" onClick={() => setHistory([])} disabled={busy}>
            NEW SESSION
          </Button>
        )}
        <Button tier="ghost" onClick={() => void start('/desk/review', {}, 'operator-requested review')} disabled={busy || !status?.configured}>
          RUN REVIEW
        </Button>
      </PanelHeader>
      <PanelBody className="flex flex-col gap-3 p-3">
        <HowToRead terms={ASK_TERMS}>
          Ask a market or portfolio question. A portfolio manager model splits it across specialist agents that read live data, then writes one answer with its
          sources. Nothing is proposed or traded unless you tick "let the desk act".
        </HowToRead>
        {status && !status.configured && <ErrorBlock message="No model configured. Set an analyst provider key (see README: Desk)." />}
        <textarea
          className="input w-full min-h-[72px] text-md p-2 bg-transparent border border-border resize-y"
          placeholder="Is the current rally a bull trap or driven by genuine flows?"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) ask()
          }}
          disabled={busy}
        />
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-1.5 text-sm text-text-secondary cursor-pointer">
            <input type="checkbox" checked={act} onChange={(e) => setAct(e.target.checked)} disabled={busy} />
            let the desk act (proposals go through the governor{status?.approval === 'manual' ? ' and wait for approval' : ''})
          </label>
          <div className="ml-auto flex gap-2">
            {busy && (
              <Button tier="ghost" onClick={() => abort.current?.abort()}>
                STOP STREAM
              </Button>
            )}
            <Button tier="neutral" onClick={() => ask()} disabled={busy || !question.trim() || !status?.configured}>
              {busy ? 'WORKING…' : 'ASK'}
            </Button>
          </div>
        </div>
        {!run && (
          <div className="flex flex-col gap-1">
            {SUGGESTIONS.map((s) => (
              <button key={s} className="text-left text-sm text-text-secondary hover:text-text-primary" onClick={() => ask(s)} disabled={busy || !status?.configured}>
                → {s}
              </button>
            ))}
          </div>
        )}
        {err && <ErrorBlock message={err} />}
        {run && <RunDetail run={run} live={busy} />}
      </PanelBody>
    </Panel>
  )
}

const ASK_TERMS: Term[] = [
  ['RUN REVIEW', 'Starts a full review of the book now, the same run the schedule starts. A review may propose entries and exits; they go through the governor.'],
  ['NEW SESSION', 'Forgets the earlier questions and answers, so the next question starts without that context.'],
  ['let the desk act', 'Off: the team only answers. On: it may also propose entries, exits and alerts. Proposals still pass the governor and, in approve-each mode, wait for you.'],
  ['RUNNING / DONE / red badge', 'State of one agent. A red badge shows why it stopped early, for example timeout, error or max_rounds.'],
  ['n tools', 'Number of data lookups the agent made. Each chip is one lookup; red means it failed. Open the lane for the task and what each lookup returned.'],
  ['SOURCES', 'Web pages the agents cited.'],
  ['Last line', 'How the run ended (end means normally), agents used, tokens read and written in thousands, and the estimated model cost in USD.'],
]

function RunDetail({ run, live }: { run: RunView; live: boolean }) {
  const pm = run.agents.find((a) => a.id === 'pm')
  const team = run.agents.filter((a) => a.id !== 'pm')
  return (
    <div className="flex flex-col gap-3 min-w-0">
      {pm && <AgentLane agent={pm} defaultOpen={false} />}
      {team.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          {team.map((a) => (
            <AgentLane key={a.id} agent={a} defaultOpen={false} />
          ))}
        </div>
      )}
      {run.proposals.length > 0 && (
        <div className="flex flex-col gap-1">
          {run.proposals.map((p) => (
            <div key={p.id} className="flex items-center gap-2 text-sm">
              <Badge tone={STATUS_TONE[p.status] ?? 'gray'}>{p.status.toUpperCase()}</Badge>
              <span className="text-text-primary">{p.summary}</span>
            </div>
          ))}
        </div>
      )}
      {run.errors.map((e) => (
        <div key={e} className="text-sm text-red-text" role="alert">
          {e}
        </div>
      ))}
      {pm?.text ? (
        <div className="border-t border-border-subtle pt-3 min-w-0">
          <Markdown text={pm.text} />
        </div>
      ) : (
        live && <span className="text-sm text-text-secondary">the team is working…</span>
      )}
      {run.citations.length > 0 && (
        <div className="flex flex-col gap-0.5 border-t border-border-subtle pt-2">
          <span className="label text-2xs">SOURCES</span>
          {run.citations.slice(0, 12).map((c) => (
            <a key={c.url} href={c.url} target="_blank" rel="noreferrer" className="text-xs text-text-secondary hover:text-text-primary truncate">
              {c.title ?? c.url}
            </a>
          ))}
        </div>
      )}
      {run.done && (
        <span className="text-xs text-text-secondary tabular">
          {run.done.stop} · {run.agents.length} agents · {(run.done.usage.input_tokens / 1000).toFixed(0)}k in / {(run.done.usage.output_tokens / 1000).toFixed(1)}k out
          {run.done.costUsd != null ? ` · ~$${run.done.costUsd.toFixed(2)}` : ''}
        </span>
      )}
    </div>
  )
}

function AgentLane({ agent, defaultOpen }: { agent: AgentView; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  const tone = agent.state === 'running' ? 'amber' : agent.state === 'done' ? 'green' : 'red'
  return (
    <div className="border border-border-subtle p-2 flex flex-col gap-1 min-w-0">
      <button className="flex items-center gap-2 text-left min-w-0" onClick={() => setOpen((o) => !o)}>
        <Badge tone={tone}>{agent.state === 'running' ? 'RUNNING' : agent.state === 'done' ? 'DONE' : (agent.stop ?? 'ERR').toUpperCase()}</Badge>
        <span className="text-sm text-text-primary truncate">{agent.role}</span>
        <span className="text-xs text-text-secondary ml-auto shrink-0">{agent.tools.length} tools</span>
      </button>
      <div className="flex flex-wrap gap-1">
        {agent.tools.map((t) => (
          <span key={t.id} title={t.summary} className={`src-tag ${t.ok === false ? 'text-red-text' : ''}`}>
            {t.name}
          </span>
        ))}
      </div>
      {open && (
        <div className="flex flex-col gap-2 pt-1 min-w-0">
          <span className="text-xs text-text-secondary whitespace-pre-wrap break-words">{agent.task}</span>
          {agent.text && agent.id !== 'pm' && <Markdown text={agent.text} />}
          {agent.tools.some((t) => t.summary) && (
            <ul className="text-xs text-text-secondary">
              {agent.tools.map((t) => (
                <li key={t.id} className="break-words">
                  {t.name}: {t.summary ?? '…'}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

function ApprovalsPanel({ limits, proposals, loading, error, offline, onRetry, onChange }: { limits: DeskStatus['limits'] | undefined; proposals: ProposalRecord[] | undefined; loading: boolean; error: string | null; offline: boolean; onRetry: () => void; onChange: () => void }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [approving, setApproving] = useState<ProposalRecord | null>(null)
  const pending = proposals?.filter((p) => p.status === 'pending') ?? []
  const recent = proposals?.filter((p) => p.status !== 'pending').slice(0, 8) ?? []

  const decide = async (id: string, verb: 'approve' | 'reject') => {
    setBusy(id)
    setErr(null)
    try {
      await api.post(`/desk/proposals/${id}/${verb}`)
      return true
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'failed')
      return false
    } finally {
      setBusy(null)
      onChange()
    }
  }
  const approvingWhat = approving && (approving.kind === 'exit' ? `exit ${Math.round(((approving.proposal as ExitProposal).fraction ?? 0) * 100)}% of ${approving.proposal.coin}` : `${(approving.proposal as TradeProposal).side} ${approving.proposal.coin}`)

  return (
    <Panel>
      <PanelHeader title="PROPOSALS">{pending.length > 0 && <Badge tone="amber">{pending.length} PENDING</Badge>}</PanelHeader>
      <PanelBody className="flex flex-col">
        <HowToRead className="px-3 pt-2" terms={proposalTerms(limits)}>
          Entries and exits the agents or the ORDER tab submitted, newest pending first, then the last 8 decided. Each shows the size and risk the governor
          computed and, when blocked, why.
        </HowToRead>
        {err && <div className="px-3 pt-2 text-sm text-red-text">{err}</div>}
        <AsyncBody
          loading={loading}
          data={proposals}
          error={error}
          offline={offline}
          onRetry={onRetry}
          rows={3}
          empty={{ label: 'No proposals yet. One appears when an agent run or the ORDER tab submits an entry or exit.' }}
        >
          {() =>
            [...pending, ...recent].map((p) => (
              <ProposalCard key={p.id} p={p} busy={busy === p.id} onDecide={(v) => (v === 'approve' ? (setErr(null), setApproving(p)) : void decide(p.id, v))} />
            ))
          }
        </AsyncBody>
      </PanelBody>
      {approving && (
        <ConfirmDialog
          title={`Approve ${approvingWhat}`}
          body={`Approve ${approvingWhat}? The desk places it on its venue, within the governor limits.`}
          confirmLabel="APPROVE"
          onConfirm={() => void decide(approving.id, 'approve').then((ok) => ok && setApproving(null))}
          onCancel={() => setApproving(null)}
          error={err}
          busy={busy === approving.id}
        />
      )}
    </Panel>
  )
}

function ProposalCard({ p, busy, onDecide }: { p: ProposalRecord; busy: boolean; onDecide: (v: 'approve' | 'reject') => void }) {
  const [open, setOpen] = useState(p.status === 'pending')
  const s = p.verdict.sizing
  // An operator (copilot) order carries no thesis, setup or confidence.
  const op = p.kind === 'open' && 'source' in p.proposal ? (p.proposal as OperatorOrderRecord) : null
  const open_ = p.kind === 'open' && !op ? (p.proposal as TradeProposal) : null
  const entry = op ?? open_
  const exit = p.kind === 'exit' ? (p.proposal as ExitProposal) : null
  return (
    <div className="border-b border-border-subtle p-3 flex flex-col gap-1.5 min-w-0">
      <div className="flex items-center gap-2 min-w-0">
        <button className="flex items-center gap-2 text-left shrink-0" onClick={() => setOpen((o) => !o)}>
          <Badge tone={STATUS_TONE[p.status] ?? 'gray'}>{p.status.toUpperCase()}</Badge>
          <span className={`text-md ${entry?.side === 'short' ? 'text-red-text' : 'text-green'}`}>
            {entry ? entry.side.toUpperCase() : `EXIT ${Math.round((exit?.fraction ?? 0) * 100)}%`}
          </span>
        </button>
        <CoinLink coin={(entry ?? exit)?.coin ?? ''} className={`text-md hover:underline ${entry?.side === 'short' ? 'text-red-text' : 'text-green'}`} />
        <button className="flex flex-1 items-center gap-2 text-left min-w-0" onClick={() => setOpen((o) => !o)}>
          <span className="text-xs text-text-secondary truncate">{op ? 'operator order (copilot)' : (open_?.setup ?? exit?.reason)}</span>
          <span className="text-xs text-text-secondary ml-auto shrink-0 tabular">{new Date(p.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
        </button>
      </div>
      {s && (
        <div className="text-xs text-text-secondary tabular">
          mark {fmtPx(s.markPx)}
          {entry &&
            ` · stop ${fmtPx(entry.stop)} (${s.stopDistPct}%) · target ${entry.target != null ? fmtPx(entry.target) : 'none'} · R:R ${s.rr ?? 'n/a'} · risk ${fmtUsd(s.riskUsd)}`}{' '}
          · size {s.size} ({fmtUsd(s.notionalUsd)})
        </div>
      )}
      {open && (
        <div className="flex flex-col gap-1.5">
          {open_ && (
            <>
              <p className="text-sm text-text-primary whitespace-pre-wrap break-words">{open_.thesis}</p>
              <p className="text-xs text-text-secondary">Invalidation: {open_.invalidation}</p>
              <ul className="text-xs text-text-secondary">
                {open_.evidence.map((e, i) => (
                  <li key={i} className="break-words">
                    [{e.source}] {e.point}
                  </li>
                ))}
              </ul>
              <span className="text-xs text-text-secondary">
                {open_.horizon} · confidence {open_.confidence} · asked {open_.riskPct}% risk
              </span>
            </>
          )}
          {op && (
            <span className="text-xs text-text-secondary">
              asked {op.notionalUsd != null ? `${fmtUsd(op.notionalUsd)} notional` : op.leverage != null ? `${op.leverage}x equity` : `${op.riskPct}% risk`} · sized at{' '}
              {op.resolvedRiskPct.toFixed(2)}% risk
            </span>
          )}
          {p.verdict.reasons.map((r) => (
            <span key={r} className="text-xs text-red-text">
              ✕ {r}
            </span>
          ))}
          {p.verdict.warnings.map((w) => (
            <span key={w} className="text-xs text-amber">
              ⚠ {w}
            </span>
          ))}
          {p.execution?.error && <span className="text-xs text-red-text">{p.execution.error}</span>}
          {p.decidedBy && <span className="text-xs text-text-secondary">decided by {p.decidedBy}</span>}
        </div>
      )}
      {p.status === 'pending' && (
        <div className="flex gap-2 pt-1">
          <Button tier="neutral" onClick={() => onDecide('approve')} disabled={busy}>
            APPROVE
          </Button>
          <Button tier="ghost" onClick={() => onDecide('reject')} disabled={busy}>
            REJECT
          </Button>
          {p.expiresAt && <span className="text-xs text-text-secondary self-center ml-auto">expires {new Date(p.expiresAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</span>}
        </div>
      )}
    </div>
  )
}

/** A coin that opens its coin page (the TRADE cross-link, docs/design/terminal.md C1). */
function CoinLink({ coin, className = 'hover:underline' }: { coin: string; className?: string }) {
  return (
    <Link to={`/coin/${encodeURIComponent(coin)}`} className={className} title={`open ${coin}`}>
      {coin}
    </Link>
  )
}

type DeskPosition = Portfolio['desk']['positions'][number]

const BOOK_COLUMNS: Column<DeskPosition>[] = [
  {
    key: 'coin',
    label: 'COIN',
    priority: 1,
    render: (p) => (
      <span className={p.side === 'long' ? 'text-green' : 'text-red-text'}>
        {p.side === 'long' ? '▲' : '▼'} <CoinLink coin={p.coin} />
      </span>
    ),
  },
  { key: 'size', label: 'SIZE', priority: 1, align: 'right', render: (p) => p.size },
  { key: 'entry', label: 'ENTRY', priority: 1, align: 'right', render: (p) => <span className="text-text-muted">{fmtPx(p.entryPx)}</span> },
  { key: 'stop', label: 'STOP', priority: 1, align: 'right', render: (p) => <span className="text-text-muted">{fmtPx(p.stopPx)}</span> },
  {
    key: 'upnl',
    label: <span title="unrealized profit or loss at the current mark, in USD">UPNL</span>,
    priority: 1,
    align: 'right',
    render: (p) => <span className={p.unrealizedPnl >= 0 ? 'text-green' : 'text-red-text'}>{fmtUsd(p.unrealizedPnl)}</span>,
  },
]

function PositionsPanel({ portfolio, loading, onChange }: { portfolio: Portfolio | null; loading: boolean; onChange: () => void }) {
  const [closing, setClosing] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const close = async (coin: string) => {
    setErr(null)
    try {
      await api.post('/desk/exit', { coin, fraction: 1, reason: 'closed by the operator from the Desk page' })
      setClosing(null)
      onChange()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'failed')
    }
  }
  const closeColumn: Column<DeskPosition> = {
    key: 'close',
    label: '',
    priority: 1,
    align: 'right',
    render: (p) => (
      <Button tier="ghost" className="!h-5 !px-1.5" onClick={() => setClosing(p.coin)}>
        CLOSE
      </Button>
    ),
  }
  const book = (title: string, acc: Portfolio['desk'], closable: boolean) => (
    <div className="flex flex-col">
      <div className="px-3 pt-2 flex items-center gap-2">
        <span className="label text-2xs">{title}</span>
        <span className="text-xs text-text-secondary tabular ml-auto">{acc.available ? fmtUsd(acc.equityUsd) : (acc.note ?? 'unavailable')}</span>
      </div>
      {acc.positions.length === 0 ? (
        <span className="px-3 py-2 text-xs text-text-secondary">no open positions</span>
      ) : (
        <DataTable columns={closable ? [...BOOK_COLUMNS, closeColumn] : BOOK_COLUMNS} rows={acc.positions} rowKey={(p) => p.coin} />
      )}
    </div>
  )
  return (
    <Panel>
      <PanelHeader title="BOOK" />
      <PanelBody className="flex flex-col gap-1 pb-2">
        <HowToRead className="px-3 pt-2" terms={BOOK_TERMS}>
          Open positions on the desk account, marked at the live price. Compare ENTRY with STOP to see what each position risks; CLOSE exits the whole position.
        </HowToRead>
        {loading && !portfolio && <SkeletonRows rows={2} />}
        {portfolio && book(`DESK (${portfolio.desk.venue.toUpperCase()})`, portfolio.desk, true)}
        {portfolio?.watched && book('WATCHED HYPERLIQUID ACCOUNT (READ-ONLY)', portfolio.watched, false)}
        {portfolio && portfolio.fills.length > 0 && (
          <div className="px-3 pt-2 flex flex-col gap-0.5">
            <span className="label text-2xs">RECENT FILLS</span>
            {portfolio.fills.slice(0, 6).map((f) => (
              <span key={f.id} className="text-xs text-text-secondary tabular">
                {new Date(f.ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} {f.side} {f.size} <CoinLink coin={f.coin} /> @ {fmtPx(f.px)} · {f.reason}
                {f.pnl !== 0 ? ` · ${fmtUsd(f.pnl)}` : ''}
              </span>
            ))}
          </div>
        )}
        {err && <span className="px-3 text-sm text-red-text">{err}</span>}
      </PanelBody>
      {closing && (
        <ConfirmDialog
          title={`Close ${closing}`}
          body="Closes the whole position at the live mark on the desk's venue (a reduce-only market order on a live venue)."
          confirmLabel="CLOSE"
          onConfirm={() => void close(closing)}
          onCancel={() => setClosing(null)}
          error={err}
        />
      )}
    </Panel>
  )
}

function AlertsPanel({ alerts, loading, error, offline, onRetry }: { alerts: AlertRow[] | undefined; loading: boolean; error: string | null; offline: boolean; onRetry: () => void }) {
  return (
    <Panel>
      <PanelHeader title="ALERTS" />
      <PanelBody className="flex flex-col max-h-[420px] overflow-y-auto">
        <HowToRead className="px-3 pt-2" terms={ALERT_TERMS}>
          What the desk flagged, newest first: large moves in watched or held coins, risk events on the book and proposal decisions. Each states what was
          measured, not what to do.
        </HowToRead>
        <AsyncBody
          loading={loading}
          data={alerts}
          error={error}
          offline={offline}
          onRetry={onRetry}
          rows={3}
          empty={{ label: 'No alerts yet. The desk checks watched and held coins on a timer and writes one here when a threshold is crossed.' }}
        >
          {(rows) =>
            rows.map((a) => (
              <div key={a.id} className="border-b border-border-subtle px-3 py-2 flex flex-col gap-0.5 min-w-0">
                <div className="flex items-center gap-2">
                  <Badge tone={a.level === 'critical' ? 'red' : a.level === 'warn' ? 'amber' : 'info'}>{a.level.toUpperCase()}</Badge>
                  <span className="text-sm text-text-primary truncate">{a.title}</span>
                  <span className="text-xs text-text-secondary ml-auto shrink-0 tabular">{new Date(a.ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</span>
                </div>
                <span className="text-xs text-text-secondary whitespace-pre-wrap break-words line-clamp-4">{a.body}</span>
              </div>
            ))
          }
        </AsyncBody>
      </PanelBody>
    </Panel>
  )
}

function RunsPanel({ schedule, runs, loading, error, offline, onRetry }: { schedule: DeskStatus['schedule'] | undefined; runs: RunRow[] | undefined; loading: boolean; error: string | null; offline: boolean; onRetry: () => void }) {
  const [openId, setOpenId] = useState<string | null>(null)
  const [view, setView] = useState<RunView | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const openRun = async (r: RunRow) => {
    if (openId === r.id) return setOpenId(null)
    setOpenId(r.id)
    setView(null)
    setErr(null)
    try {
      const full = await api.get<RunRow & { events: Array<{ type: string; agent: string; data: Record<string, unknown> }> }>(`/desk/runs/${r.id}`)
      let v = emptyRun(r.kind, r.question)
      for (const e of full.events) v = reduceRun(v, { type: e.type, ...e.data } as DeskEvent)
      // The PM's final answer is stored on the run (deltas are not persisted).
      v = { ...v, agents: v.agents.map((a) => (a.id === 'pm' && full.answer ? { ...a, text: full.answer } : a)) }
      setView(v)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'failed')
    }
  }

  return (
    <Panel>
      <PanelHeader title="RUNS" />
      <PanelBody className="flex flex-col">
        <HowToRead
          className="px-3 pt-2"
          terms={[
            ['ASK', 'A run you started with a question.'],
            [
              'CYCLE',
              `A review run: scheduled, started with RUN REVIEW, or started by an alert.${schedule ? ` Alert-started runs are at least ${schedule.cycleCooldownMin} minutes apart, and at most ${schedule.maxCyclesPerDay} cycles run per UTC day.` : ''}`,
            ],
            ['Badge colour', 'Green finished, amber still running, red ended with an error.'],
            ['$', 'Estimated model cost of the run in USD.'],
          ]}
        >
          The last 15 runs of the agent team, newest first. Open one to replay which agents ran, what data they read and the answer.
        </HowToRead>
        <AsyncBody loading={loading} data={runs} error={error} offline={offline} onRetry={onRetry} rows={3} empty={{ label: 'No runs yet. Ask a question above or run a review to create one.' }}>
          {(list) =>
            list.map((r) => (
              <div key={r.id} className="border-b border-border-subtle">
                <button className="w-full px-3 py-2 flex items-center gap-2 text-left min-w-0" onClick={() => void openRun(r)}>
                  <Badge tone={r.status === 'done' ? 'green' : r.status === 'running' ? 'amber' : 'red'}>{r.kind.toUpperCase()}</Badge>
                  <span className="text-sm text-text-primary truncate">{r.question}</span>
                  <span className="text-xs text-text-secondary ml-auto shrink-0 tabular">
                    {new Date(r.startedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                    {r.costUsd != null ? ` · $${r.costUsd.toFixed(2)}` : ''}
                  </span>
                </button>
                {openId === r.id && (
                  <div className="px-3 pb-3">
                    {err && <ErrorBlock message={err} />}
                    {!view && !err && <SkeletonRows rows={2} />}
                    {view && <RunDetail run={view} live={false} />}
                  </div>
                )}
              </div>
            ))
          }
        </AsyncBody>
      </PanelBody>
    </Panel>
  )
}
