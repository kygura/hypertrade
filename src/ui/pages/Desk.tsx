import { useCallback, useEffect, useRef, useState } from 'react'
import { Badge, Button, ConfirmDialog, EmptyBlock, ErrorBlock, OfflineBlock, Panel, PanelBody, PanelHeader, Segmented, SkeletonRows } from '../components'
import { Markdown } from '../components/analyst/Markdown'
import { api, ApiError, NetworkError, useApi } from '../lib/api'
import {
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
  type Portfolio,
  type ProposalRecord,
  type RunRow,
  type RunView,
  type TradeProposal,
} from '../lib/desk'

// /desk — the agentic portfolio desk (SPEC.md "Desk"). Ask the team a
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

export function Desk() {
  const status = useApi<DeskStatus>('/desk/status')
  const portfolio = useApi<Portfolio>('/desk/portfolio')
  const proposals = useApi<{ proposals: ProposalRecord[] }>('/desk/proposals?limit=30')
  const alerts = useApi<{ alerts: AlertRow[] }>('/desk/alerts?limit=30')
  const runs = useApi<{ runs: RunRow[] }>('/desk/runs?limit=15')

  const refreshBook = useCallback(() => {
    portfolio.refetch()
    proposals.refetch()
    alerts.refetch()
    runs.refetch()
  }, [portfolio, proposals, alerts, runs])

  if (status.offline) return <OfflineBlock onRetry={status.refetch} />
  if (status.error) return <ErrorBlock message={status.error} onRetry={status.refetch} />

  return (
    <div className="flex flex-col gap-3 p-3 min-w-0">
      <HeaderStrip status={status.data} portfolio={portfolio.data} onChange={() => (status.refetch(), refreshBook())} />
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-3 min-w-0">
        <div className="xl:col-span-2 flex flex-col gap-3 min-w-0">
          <AskPanel status={status.data} onRunFinished={refreshBook} />
          <RunsPanel runs={runs.data?.runs} loading={runs.loading} />
        </div>
        <div className="flex flex-col gap-3 min-w-0">
          <ApprovalsPanel proposals={proposals.data?.proposals} loading={proposals.loading} onChange={refreshBook} />
          <PositionsPanel portfolio={portfolio.data} loading={portfolio.loading} onChange={refreshBook} />
          <AlertsPanel alerts={alerts.data?.alerts} loading={alerts.loading} />
        </div>
      </div>
    </div>
  )
}

function HeaderStrip({ status, portfolio, onChange }: { status: DeskStatus | null; portfolio: Portfolio | null; onChange: () => void }) {
  const [confirm, setConfirm] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const kill = status?.killSwitch.on ?? false
  const desk = portfolio?.desk

  const setApproval = async (approval: 'manual' | 'auto') => {
    await api.put('/desk/approval', { approval }).catch(() => undefined)
    onChange()
  }
  const toggleKill = async () => {
    setBusy(true)
    setErr(null)
    try {
      await api.post('/desk/kill', { on: !kill })
      setConfirm(false)
      onChange()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Panel>
      <PanelBody className="flex flex-wrap items-center gap-x-5 gap-y-2 p-3">
        <div className="flex items-center gap-2">
          <span className="text-[13px] text-text-primary font-display tracking-wider">DESK</span>
          <Badge tone="info">{(status?.venue ?? 'paper').toUpperCase()}</Badge>
          {kill && <Badge tone="red">KILL SWITCH</Badge>}
        </div>
        <Stat label="EQUITY" value={desk ? fmtUsd(desk.equityUsd) : '—'} />
        <Stat label="DAY" value={desk ? fmtUsd(desk.dayPnlUsd) : '—'} tone={desk ? (desk.dayPnlUsd >= 0 ? 'text-green' : 'text-red-text') : undefined} />
        <Stat label="POSITIONS" value={desk ? String(desk.positions.length) : '—'} />
        <Stat label="MODEL" value={status?.model ? `${status.model.pm}${status.model.specialists !== status.model.pm ? ` / ${status.model.specialists}` : ''}` : 'not configured'} />
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
          <Button tier="danger" onClick={() => setConfirm(true)} disabled={!status}>
            {kill ? 'RESUME' : 'KILL'}
          </Button>
        </div>
      </PanelBody>
      {status && !status.liveVenue.available && (
        <div className="px-3 pb-2 text-[10px] text-text-secondary">{status.liveVenue.note}.</div>
      )}
      {confirm && (
        <ConfirmDialog
          title={kill ? 'Resume entries' : 'Kill switch'}
          body={kill ? 'New entries will be allowed again, within the governor limits.' : 'Blocks every new entry, from agents and approvals alike. Exits stay allowed.'}
          confirmLabel={kill ? 'RESUME' : 'KILL'}
          typedWord={kill ? undefined : 'KILL'}
          onConfirm={() => void toggleKill()}
          onCancel={() => setConfirm(false)}
          error={err}
          busy={busy}
        />
      )}
    </Panel>
  )
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex flex-col min-w-0">
      <span className="label text-[9px]">{label}</span>
      <span className={`text-[12px] tabular truncate ${tone ?? 'text-text-primary'}`}>{value}</span>
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
        {status && !status.configured && <ErrorBlock message="No model configured. Set an analyst provider key (see README: Desk)." />}
        <textarea
          className="input w-full min-h-[72px] text-[12px] p-2 bg-transparent border border-border resize-y"
          placeholder="Is the current rally a bull trap or driven by genuine flows?"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) ask()
          }}
          disabled={busy}
        />
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-1.5 text-[11px] text-text-secondary cursor-pointer">
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
              <button key={s} className="text-left text-[11px] text-text-secondary hover:text-text-primary" onClick={() => ask(s)} disabled={busy || !status?.configured}>
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
            <div key={p.id} className="flex items-center gap-2 text-[11px]">
              <Badge tone={STATUS_TONE[p.status] ?? 'gray'}>{p.status.toUpperCase()}</Badge>
              <span className="text-text-primary">{p.summary}</span>
            </div>
          ))}
        </div>
      )}
      {run.errors.map((e) => (
        <div key={e} className="text-[11px] text-red-text" role="alert">
          {e}
        </div>
      ))}
      {pm?.text ? (
        <div className="border-t border-border-subtle pt-3 min-w-0">
          <Markdown text={pm.text} />
        </div>
      ) : (
        live && <span className="text-[11px] text-text-secondary">the team is working…</span>
      )}
      {run.citations.length > 0 && (
        <div className="flex flex-col gap-0.5 border-t border-border-subtle pt-2">
          <span className="label text-[9px]">SOURCES</span>
          {run.citations.slice(0, 12).map((c) => (
            <a key={c.url} href={c.url} target="_blank" rel="noreferrer" className="text-[10px] text-text-secondary hover:text-text-primary truncate">
              {c.title ?? c.url}
            </a>
          ))}
        </div>
      )}
      {run.done && (
        <span className="text-[10px] text-text-secondary tabular">
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
        <Badge tone={tone}>{agent.state === 'running' ? 'RUN' : agent.state === 'done' ? 'DONE' : (agent.stop ?? 'ERR').toUpperCase()}</Badge>
        <span className="text-[11px] text-text-primary truncate">{agent.role}</span>
        <span className="text-[10px] text-text-secondary ml-auto shrink-0">{agent.tools.length} tools</span>
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
          <span className="text-[10px] text-text-secondary whitespace-pre-wrap break-words">{agent.task}</span>
          {agent.text && agent.id !== 'pm' && <Markdown text={agent.text} />}
          {agent.tools.some((t) => t.summary) && (
            <ul className="text-[10px] text-text-secondary">
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

function ApprovalsPanel({ proposals, loading, onChange }: { proposals: ProposalRecord[] | undefined; loading: boolean; onChange: () => void }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const pending = proposals?.filter((p) => p.status === 'pending') ?? []
  const recent = proposals?.filter((p) => p.status !== 'pending').slice(0, 8) ?? []

  const decide = async (id: string, verb: 'approve' | 'reject') => {
    setBusy(id)
    setErr(null)
    try {
      await api.post(`/desk/proposals/${id}/${verb}`)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'failed')
    } finally {
      setBusy(null)
      onChange()
    }
  }

  return (
    <Panel>
      <PanelHeader title="PROPOSALS">{pending.length > 0 && <Badge tone="amber">{pending.length} PENDING</Badge>}</PanelHeader>
      <PanelBody className="flex flex-col">
        {loading && !proposals && <SkeletonRows rows={3} />}
        {proposals && proposals.length === 0 && <EmptyBlock label="no proposals yet" />}
        {err && <div className="px-3 pt-2 text-[11px] text-red-text">{err}</div>}
        {[...pending, ...recent].map((p) => (
          <ProposalCard key={p.id} p={p} busy={busy === p.id} onDecide={(v) => void decide(p.id, v)} />
        ))}
      </PanelBody>
    </Panel>
  )
}

function ProposalCard({ p, busy, onDecide }: { p: ProposalRecord; busy: boolean; onDecide: (v: 'approve' | 'reject') => void }) {
  const [open, setOpen] = useState(p.status === 'pending')
  const s = p.verdict.sizing
  const open_ = p.kind === 'open' ? (p.proposal as TradeProposal) : null
  const exit = p.kind === 'exit' ? (p.proposal as ExitProposal) : null
  return (
    <div className="border-b border-border-subtle p-3 flex flex-col gap-1.5 min-w-0">
      <button className="flex items-center gap-2 text-left min-w-0" onClick={() => setOpen((o) => !o)}>
        <Badge tone={STATUS_TONE[p.status] ?? 'gray'}>{p.status.toUpperCase()}</Badge>
        <span className={`text-[12px] ${open_?.side === 'short' ? 'text-red-text' : 'text-green'}`}>
          {open_ ? `${open_.side.toUpperCase()} ${open_.coin}` : `EXIT ${Math.round((exit?.fraction ?? 0) * 100)}% ${exit?.coin}`}
        </span>
        <span className="text-[10px] text-text-secondary truncate">{open_?.setup ?? exit?.reason}</span>
        <span className="text-[10px] text-text-secondary ml-auto shrink-0 tabular">{new Date(p.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
      </button>
      {s && (
        <div className="text-[10px] text-text-secondary tabular">
          mark {fmtPx(s.markPx)}
          {open_ && ` · stop ${fmtPx(open_.stop)} (${s.stopDistPct}%) · target ${fmtPx(open_.target)} · R:R ${s.rr} · risk ${fmtUsd(s.riskUsd)}`} · size {s.size} ({fmtUsd(s.notionalUsd)})
        </div>
      )}
      {open && (
        <div className="flex flex-col gap-1.5">
          {open_ && (
            <>
              <p className="text-[11px] text-text-primary whitespace-pre-wrap break-words">{open_.thesis}</p>
              <p className="text-[10px] text-text-secondary">Invalidation: {open_.invalidation}</p>
              <ul className="text-[10px] text-text-secondary">
                {open_.evidence.map((e, i) => (
                  <li key={i} className="break-words">
                    [{e.source}] {e.point}
                  </li>
                ))}
              </ul>
              <span className="text-[10px] text-text-secondary">
                {open_.horizon} · confidence {open_.confidence} · asked {open_.riskPct}% risk
              </span>
            </>
          )}
          {p.verdict.reasons.map((r) => (
            <span key={r} className="text-[10px] text-red-text">
              ✕ {r}
            </span>
          ))}
          {p.verdict.warnings.map((w) => (
            <span key={w} className="text-[10px] text-amber">
              ⚠ {w}
            </span>
          ))}
          {p.execution?.error && <span className="text-[10px] text-red-text">{p.execution.error}</span>}
          {p.decidedBy && <span className="text-[10px] text-text-secondary">decided by {p.decidedBy}</span>}
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
          {p.expiresAt && <span className="text-[10px] text-text-secondary self-center ml-auto">expires {new Date(p.expiresAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</span>}
        </div>
      )}
    </div>
  )
}

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
  const book = (title: string, acc: Portfolio['desk'], closable: boolean) => (
    <div className="flex flex-col">
      <div className="px-3 pt-2 flex items-center gap-2">
        <span className="label text-[9px]">{title}</span>
        <span className="text-[10px] text-text-secondary tabular ml-auto">{acc.available ? fmtUsd(acc.equityUsd) : (acc.note ?? 'unavailable')}</span>
      </div>
      {acc.positions.length === 0 ? (
        <span className="px-3 py-2 text-[10px] text-text-secondary">flat</span>
      ) : (
        <div className="table-scroll">
          <table className="w-full text-[11px] tabular border-collapse">
            <thead>
              <tr className="border-b border-border">
                <th className="px-2 py-1 label text-left">COIN</th>
                <th className="px-2 py-1 label text-right">SIZE</th>
                <th className="px-2 py-1 label text-right">ENTRY</th>
                <th className="px-2 py-1 label text-right">STOP</th>
                <th className="px-2 py-1 label text-right">UPNL</th>
                {closable && <th />}
              </tr>
            </thead>
            <tbody>
              {acc.positions.map((p) => (
                <tr key={p.coin} className="border-b border-border-subtle" style={{ height: 'var(--row-h)' }}>
                  <td className={`px-2 ${p.side === 'long' ? 'text-green' : 'text-red-text'}`}>
                    {p.side === 'long' ? '▲' : '▼'} {p.coin}
                  </td>
                  <td className="px-2 text-right">{p.size}</td>
                  <td className="px-2 text-right text-text-muted">{fmtPx(p.entryPx)}</td>
                  <td className="px-2 text-right text-text-muted">{fmtPx(p.stopPx)}</td>
                  <td className={`px-2 text-right ${p.unrealizedPnl >= 0 ? 'text-green' : 'text-red-text'}`}>{fmtUsd(p.unrealizedPnl)}</td>
                  {closable && (
                    <td className="px-1 text-right">
                      <Button tier="ghost" className="!h-5 !px-1.5" onClick={() => setClosing(p.coin)}>
                        CLOSE
                      </Button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
  return (
    <Panel>
      <PanelHeader title="BOOK" />
      <PanelBody className="flex flex-col gap-1 pb-2">
        {loading && !portfolio && <SkeletonRows rows={2} />}
        {portfolio && book(`DESK (${portfolio.desk.venue.toUpperCase()})`, portfolio.desk, true)}
        {portfolio?.watched && book('WATCHED HYPERLIQUID ACCOUNT (READ-ONLY)', portfolio.watched, false)}
        {portfolio && portfolio.fills.length > 0 && (
          <div className="px-3 pt-2 flex flex-col gap-0.5">
            <span className="label text-[9px]">RECENT FILLS</span>
            {portfolio.fills.slice(0, 6).map((f) => (
              <span key={f.id} className="text-[10px] text-text-secondary tabular">
                {new Date(f.ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} {f.side} {f.size} {f.coin} @ {fmtPx(f.px)} · {f.reason}
                {f.pnl !== 0 ? ` · ${fmtUsd(f.pnl)}` : ''}
              </span>
            ))}
          </div>
        )}
        {err && <span className="px-3 text-[11px] text-red-text">{err}</span>}
      </PanelBody>
      {closing && (
        <ConfirmDialog
          title={`Close ${closing}`}
          body="Closes the whole position at the live mark on the desk's venue."
          confirmLabel="CLOSE"
          onConfirm={() => void close(closing)}
          onCancel={() => setClosing(null)}
          error={err}
        />
      )}
    </Panel>
  )
}

function AlertsPanel({ alerts, loading }: { alerts: AlertRow[] | undefined; loading: boolean }) {
  return (
    <Panel>
      <PanelHeader title="ALERTS" />
      <PanelBody className="flex flex-col max-h-[420px] overflow-y-auto">
        {loading && !alerts && <SkeletonRows rows={3} />}
        {alerts && alerts.length === 0 && <EmptyBlock label="no alerts yet" />}
        {alerts?.map((a) => (
          <div key={a.id} className="border-b border-border-subtle px-3 py-2 flex flex-col gap-0.5 min-w-0">
            <div className="flex items-center gap-2">
              <Badge tone={a.level === 'critical' ? 'red' : a.level === 'warn' ? 'amber' : 'info'}>{a.level.toUpperCase()}</Badge>
              <span className="text-[11px] text-text-primary truncate">{a.title}</span>
              <span className="text-[10px] text-text-secondary ml-auto shrink-0 tabular">{new Date(a.ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</span>
            </div>
            <span className="text-[10px] text-text-secondary whitespace-pre-wrap break-words line-clamp-4">{a.body}</span>
          </div>
        ))}
      </PanelBody>
    </Panel>
  )
}

function RunsPanel({ runs, loading }: { runs: RunRow[] | undefined; loading: boolean }) {
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
        {loading && !runs && <SkeletonRows rows={3} />}
        {runs && runs.length === 0 && <EmptyBlock label="no runs yet" />}
        {runs?.map((r) => (
          <div key={r.id} className="border-b border-border-subtle">
            <button className="w-full px-3 py-2 flex items-center gap-2 text-left min-w-0" onClick={() => void openRun(r)}>
              <Badge tone={r.status === 'done' ? 'green' : r.status === 'running' ? 'amber' : 'red'}>{r.kind.toUpperCase()}</Badge>
              <span className="text-[11px] text-text-primary truncate">{r.question}</span>
              <span className="text-[10px] text-text-secondary ml-auto shrink-0 tabular">
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
        ))}
      </PanelBody>
    </Panel>
  )
}
