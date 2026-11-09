import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router'
import { AsyncBody, Badge, Button, DialogShell, EmptyBlock, Panel, PanelHeader, PageContainer } from '../../components'
import { LabTabs } from '../../components/lab/LabTabs'
import { StudyVerdictBadge } from '../../components/lab/StudyVerdictBadge'
import { ApiError, REDIRECT_KEY, useApi } from '../../lib/api'
import { fmtAge } from '../../lib/format'
import { useNow, useQueryPatch } from '../../lib/hooks'
import { errorMessage, usePoll, type PollState } from '../../lib/poll'
import {
  BOARD_POLL_MS, boardKey, flatSignals, recentCalls, research, rootRedirect, signalBlocks, signalStudyHref, SOURCE_LABEL, studyCoin, type BoardSignal,
} from '../../lib/research'
import { fmtR } from '../../lib/study'
import { RESEARCH_SOURCES, type BoardResponse, type RadarResponse, type StudySummary } from '../../../shared/research'

// Research board — the landing `/` (docs/RESEARCH.md "Board"). Live signals from four sources,
// each with its evidence cell: the cached event study of its Lab rule, a STUDY button that runs it
// in place, or `no Lab twin`. Side column: PULSE summary and the RADAR. Container (Board) owns the
// pollers, `?coin=`, the per-row study runs and the keyboard; BoardView is presentational.
// Nothing here trades and nothing nags: facts with their n, never a verdict of the signal itself.

/** A study run in place from a row. */
export type RowStudy = { state: 'running' } | { state: 'error'; message: string } | { state: 'done'; summary: StudySummary }

export function Board() {
  const { search } = useLocation()
  const to = rootRedirect(search)
  if (to) return <Navigate to={to} replace />
  return <BoardPage />
}

function BoardPage() {
  const [params] = useSearchParams()
  const patch = useQueryPatch()
  const navigate = useNavigate()
  const location = useLocation()
  const now = useNow(30_000)
  const coin = params.get('coin')

  const me = useApi<{ ok: boolean; guest?: boolean }>('/auth/me')
  // Unknown until /auth/me answers: a guest never fires the POST (a 401 would bounce to /login).
  const guest = me.data ? me.data.guest === true : null
  const board = usePoll(research.board, [], { intervalMs: BOARD_POLL_MS })
  // The radar needs a session: a guest sees the sign-in affordance instead of a fetch.
  const radar = usePoll(research.radar, [], { enabled: guest === false })

  const [studies, setStudies] = useState<Record<string, RowStudy>>({})
  const runStudy = useCallback(async (s: BoardSignal) => {
    if (!s.rule) return
    setStudies((m) => ({ ...m, [s.id]: { state: 'running' } }))
    try {
      const r = await research.study(s.rule, studyCoin(s))
      setStudies((m) => ({ ...m, [s.id]: { state: 'done', summary: r.summary } }))
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return // redirect in flight
      setStudies((m) => ({ ...m, [s.id]: { state: 'error', message: errorMessage(e) } }))
    }
  }, [])

  const blocks = useMemo(() => signalBlocks(board.data?.signals ?? [], coin), [board.data, coin])
  const order = useMemo(() => flatSignals(blocks), [blocks])
  const [selected, setSelected] = useState<string | null>(null)
  const selectedId = selected && order.some((s) => s.id === selected) ? selected : (order[0]?.id ?? null)

  const signIn = useCallback(() => {
    try {
      sessionStorage.setItem(REDIRECT_KEY, `${location.pathname}${location.search}`)
    } catch {
      /* storage blocked: Login falls back to `/` */
    }
    navigate('/login')
  }, [location, navigate])

  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {})
  keyRef.current = (e) => {
    const el = document.activeElement as HTMLElement | null
    const a = boardKey({ key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, target: el?.tagName, editable: el?.isContentEditable, dialogOpen: document.querySelector('[role="dialog"]') != null })
    if (!a) return
    if (a === 'open' && el && ['BUTTON', 'A'].includes(el.tagName)) return // the control's own Enter
    const cur = order.find((s) => s.id === selectedId)
    if (a === 'next' || a === 'prev') {
      const i = order.findIndex((s) => s.id === selectedId)
      const next = order[Math.min(order.length - 1, Math.max(0, i + (a === 'next' ? 1 : -1)))]
      if (!next) return
      e.preventDefault()
      setSelected(next.id)
      document.querySelector(`[data-signal="${CSS.escape(next.id)}"]`)?.scrollIntoView({ block: 'nearest' })
      return
    }
    if (!cur) return
    if (a === 'open') {
      const href = signalStudyHref(cur)
      if (href) (e.preventDefault(), navigate(href))
      return
    }
    if (a === 'study' && cur.rule && !cur.evidence && studies[cur.id]?.state !== 'running' && studies[cur.id]?.state !== 'done' && guest === false) {
      e.preventDefault()
      void runStudy(cur)
    }
  }
  useEffect(() => {
    const on = (e: KeyboardEvent) => keyRef.current(e)
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [])

  return (
    <BoardView
      board={board}
      radar={radar}
      guest={guest}
      coin={coin}
      now={now}
      studies={studies}
      selectedId={selectedId}
      onSelect={setSelected}
      onOpen={(href) => navigate(href)}
      onStudy={(s) => void runStudy(s)}
      onClearCoin={() => patch({ coin: null })}
      onSignIn={signIn}
    />
  )
}

type Poll<T> = Pick<PollState<T>, 'data' | 'loading' | 'error' | 'offline' | 'refetch'>

export interface BoardViewProps {
  board: Poll<BoardResponse>
  radar: Poll<RadarResponse>
  /** null while /auth/me is unanswered. */
  guest: boolean | null
  coin: string | null
  now: number
  studies: Record<string, RowStudy>
  selectedId: string | null
  onSelect: (id: string) => void
  onOpen: (href: string) => void
  onStudy: (s: BoardSignal) => void
  onClearCoin: () => void
  onSignIn: () => void
}

const LINK = 'text-xs text-text-secondary hover:text-text-primary underline-offset-2 hover:underline'

export function BoardView(p: BoardViewProps) {
  const firing = p.board.data?.pulse ? p.board.data.pulse.firing > 0 : undefined
  return (
    <PageContainer className="pb-3 md:pb-[var(--gutter)] flex flex-col">
      <LabTabs pulseFiring={firing} />
      <HeaderLine board={p.board.data} coin={p.coin} onClearCoin={p.onClearCoin} />
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-3 mt-2 min-w-0">
        <section aria-label="signals" className="lg:col-span-8 min-w-0">
          <Panel>
            <PanelHeader title="SIGNALS">
              <span className="hidden [@media(pointer:fine)]:inline text-xs text-text-secondary">j/k · enter study · s run</span>
            </PanelHeader>
            <AsyncBody loading={p.board.loading} data={p.board.data} error={p.board.error} offline={p.board.offline} onRetry={p.board.refetch} rows={6}>
              {(b) => <SignalList {...p} data={b} />}
            </AsyncBody>
          </Panel>
        </section>
        <aside aria-label="pulse and radar" className="lg:col-span-4 min-w-0 flex flex-col gap-3">
          <PulsePanel board={p.board} />
          <RadarPanel radar={p.radar} guest={p.guest} onSignIn={p.onSignIn} />
        </aside>
      </div>
    </PageContainer>
  )
}

function HeaderLine({ board, coin, onClearCoin }: { board: BoardResponse | null; coin: string | null; onClearCoin: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pt-2 min-w-0">
      <h1 className="text-sm font-display tracking-wider text-text-primary">RESEARCH BOARD</h1>
      <span className="text-xs tabular text-text-secondary">{board ? `as of ${new Date(board.asOf).toISOString().slice(11, 16)} UTC` : 'as of —'}</span>
      {board &&
        RESEARCH_SOURCES.map((src) => {
          const st = board.sources[src]
          const off = st.state === 'unavailable'
          return (
            <span key={src} title={off ? (st.reason ?? 'unavailable') : `${st.count} signal${st.count === 1 ? '' : 's'} now`} className="inline-flex">
              <Badge tone={off ? 'amber' : 'gray'}>
                {SOURCE_LABEL[src]} {off ? 'unavailable' : st.count}
              </Badge>
            </span>
          )
        })}
      {coin && (
        <Button tier="ghost" onClick={onClearCoin} aria-label={`clear the ${coin} filter`}>
          COIN {coin.toUpperCase()} ×
        </Button>
      )}
    </div>
  )
}

/** Empty board copy: which sources are on, and that nothing is firing (not an error). */
export function emptyLabel(b: BoardResponse, coin: string | null): string {
  if (coin) return `no signal on ${coin.toUpperCase()} now`
  const on = RESEARCH_SOURCES.filter((s) => b.sources[s].state === 'ok').map((s) => SOURCE_LABEL[s].toLowerCase())
  return on.length ? `no condition firing · sources on: ${on.join(', ')}` : 'no source available — see the chips above'
}

function SignalList(p: BoardViewProps & { data: BoardResponse }) {
  const blocks = signalBlocks(p.data.signals, p.coin)
  if (blocks.length === 0) return <EmptyBlock label={emptyLabel(p.data, p.coin)} action={p.coin ? { label: 'SHOW ALL', onClick: p.onClearCoin } : undefined} />
  return (
    <ul className="flex flex-col">
      {blocks.map((b) => (
        <li key={b.coin} className="border-b border-border-subtle last:border-b-0">
          {b.grouped && (
            <div className="px-3 pt-2 text-xs text-text-secondary tabular">
              {b.coin} · {b.signals.length} signals
            </div>
          )}
          <ul>
            {b.signals.map((s) => (
              <SignalRow key={s.id} {...p} s={s} />
            ))}
          </ul>
        </li>
      ))}
    </ul>
  )
}

const NO_TWIN: Record<string, string> = {
  opportunity: 'intraday scanner setups have no Lab twin: the Lab replays daily rules, so there is no history to test this against',
  radar: 'radar calls are catalyst theses written by the routine, not a condition the Lab can replay',
}

function SignalRow(p: BoardViewProps & { s: BoardSignal }) {
  const { s } = p
  const href = signalStudyHref(s)
  const selected = p.selectedId === s.id
  return (
    <li
      data-signal={s.id}
      aria-current={selected ? 'true' : undefined}
      onClick={(e) => {
        p.onSelect(s.id)
        if (href && !(e.target as HTMLElement).closest('a,button')) p.onOpen(href)
      }}
      className={`flex flex-wrap items-start gap-x-3 gap-y-1 px-3 py-2 min-w-0 ${href ? 'cursor-pointer' : ''} ${selected ? 'bg-hover' : 'hover:bg-hover'}`}
    >
      <div className="flex-1 min-w-[12rem] flex flex-col gap-0.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 min-w-0">
          {href ? (
            <Link to={href} className="text-sm font-semibold text-text-primary hover:underline" title="open the event study">
              {s.coin}
            </Link>
          ) : (
            <span className="text-sm font-semibold text-text-primary">{s.coin}</span>
          )}
          <Badge tone="gray">{SOURCE_LABEL[s.source]}</Badge>
          {s.direction && <span className={`text-xs ${s.direction === 'long' ? 'text-green' : 'text-red-text'}`}>{s.direction.toUpperCase()}</span>}
          <span className="text-xs tabular text-text-secondary">{fmtAge(new Date(s.at).toISOString(), p.now)}</span>
        </div>
        <p className="text-sm text-text-primary break-words">{s.headline}</p>
        <div className="flex flex-wrap gap-x-3">
          {s.href && (
            <Link to={s.href} className={LINK}>
              {s.source === 'rule' ? 'rule →' : s.source === 'opportunity' ? 'feed →' : 'source →'}
            </Link>
          )}
          <Link to={`/asset/${encodeURIComponent(s.coin)}`} className={LINK}>
            asset →
          </Link>
        </div>
      </div>
      <div className="basis-full sm:basis-auto sm:w-[17rem] min-w-0">
        <EvidenceCell {...p} />
      </div>
    </li>
  )
}

/** `tested short · 41 events · 38 weeks · +0.21R (≤ +0.35R)`; the tested side is a fact about the study, not advice. */
export function evidenceText(e: StudySummary, tested: 'long' | 'short' | null | undefined): string {
  return `${tested ? `tested ${tested} · ` : ''}${e.events} events · ${e.weeks} weeks · ${fmtR(e.expectancy)} (≤ ${fmtR(e.upper95)})`
}

function EvidenceCell(p: BoardViewProps & { s: BoardSignal }) {
  const { s } = p
  const local = p.studies[s.id]
  const ev = s.evidence ?? (local?.state === 'done' ? local.summary : null)
  if (ev) {
    return (
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5" title="expectancy per trade, weekly-clustered (one-sided 95% upper bound)">
        <StudyVerdictBadge verdict={ev.verdict} />
        <span className="text-xs tabular text-text-primary">{evidenceText(ev, s.tested)}</span>
      </div>
    )
  }
  if (!s.rule) {
    return (
      <span className="text-xs text-text-secondary" title={NO_TWIN[s.source] ?? 'this signal maps to no Lab rule'}>
        no Lab twin
      </span>
    )
  }
  if (local?.state === 'running') {
    return (
      <span role="status" className="text-xs text-text-secondary pulse-label">
        STUDYING… (a trial, up to ~50 s)
      </span>
    )
  }
  if (p.guest) {
    return (
      <Button tier="ghost" onClick={p.onSignIn} title="running a study needs a signed-in session">
        LOGIN TO STUDY
      </Button>
    )
  }
  return (
    <div className="flex flex-col gap-1">
      <span className="flex flex-wrap items-center gap-2">
        <Button tier="ghost" onClick={() => p.onStudy(s)} disabled={p.guest == null} title="run the event study of this rule now; it counts as a trial">
          {local?.state === 'error' ? 'RETRY STUDY' : 'STUDY'}
        </Button>
        {!local && <span className="text-xs text-text-secondary">not studied today</span>}
      </span>
      {local?.state === 'error' && (
        <span role="alert" className="text-xs text-red-text break-words">
          {local.message}
        </span>
      )}
    </div>
  )
}

function PulsePanel({ board }: { board: Poll<BoardResponse> }) {
  const b = board.data
  return (
    <Panel>
      <PanelHeader title="PULSE">
        <Link to="/lab/pulse" className={LINK}>
          open →
        </Link>
      </PanelHeader>
      <AsyncBody loading={board.loading} data={b} error={null} offline={null} rows={1}>
        {(d) =>
          d.pulse ? (
            <p className="px-3 py-2 text-sm tabular text-text-primary">
              {d.pulse.firing} catalogued rule{d.pulse.firing === 1 ? '' : 's'} firing · {d.pulse.assets} asset{d.pulse.assets === 1 ? '' : 's'} covered
            </p>
          ) : (
            <p className="px-3 py-2 text-sm text-text-secondary" title={d.sources.rule.reason}>
              pulse unavailable{d.sources.rule.reason ? ` — ${d.sources.rule.reason}` : ''}
            </p>
          )
        }
      </AsyncBody>
    </Panel>
  )
}

type Note = NonNullable<RadarResponse['latestNote']> & { truncated?: boolean }

function RadarPanel({ radar, guest, onSignIn }: { radar: Poll<RadarResponse>; guest: boolean | null; onSignIn: () => void }) {
  const [open, setOpen] = useState(false)
  return (
    <Panel>
      <PanelHeader title="RADAR" />
      {guest ? (
        <div className="flex flex-wrap items-center gap-2 px-3 py-2">
          <span className="text-sm text-text-secondary">the radar needs a signed-in session</span>
          <Button tier="ghost" onClick={onSignIn}>
            LOGIN
          </Button>
        </div>
      ) : (
        <AsyncBody loading={radar.loading || guest == null} data={radar.data} error={radar.error} offline={radar.offline} onRetry={radar.refetch} rows={3}>
          {(r) =>
            r.state === 'unavailable' ? (
              <p className="px-3 py-2 text-sm text-text-secondary">radar unavailable{r.reason ? ` — ${r.reason}` : ''}</p>
            ) : (
              <RadarBody r={r} onNote={() => setOpen(true)} />
            )
          }
        </AsyncBody>
      )}
      {open && radar.data?.latestNote && <NoteDialog note={radar.data.latestNote} onClose={() => setOpen(false)} />}
    </Panel>
  )
}

function RadarBody({ r, onNote }: { r: RadarResponse; onNote: () => void }) {
  const calls = recentCalls(r.calls)
  return (
    <div className="flex flex-col gap-2 px-3 py-2 min-w-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-text-secondary tabular">latest note {r.latestNote?.date ?? '—'}</span>
        {r.latestNote && (
          <Button tier="ghost" onClick={onNote}>
            READ NOTE
          </Button>
        )}
      </div>
      {calls.length === 0 ? (
        <p className="text-sm text-text-secondary">no calls landed</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {calls.map((c) => (
            <li key={c.id} className="text-xs tabular text-text-primary flex flex-wrap gap-x-2 min-w-0">
              <span className="font-semibold">{c.market}</span>
              <span>
                {c.stance} {c.direction}
              </span>
              <span className="text-text-secondary">kill {c.kill_price}</span>
              <span className="text-text-secondary">{c.date}</span>
              {c.killed_at && <span className="text-amber">killed {c.killed_at}</span>}
            </li>
          ))}
        </ul>
      )}
      {r.scorecard.length > 0 && (
        <div className="table-scroll">
          <table className="dt w-full text-xs tabular">
            <caption className="sr-only">radar scorecard: mean move vs BTC and hit count per horizon</caption>
            <thead>
              <tr>
                <th className="text-left">STANCE</th>
                <th className="text-right">H</th>
                <th className="text-right">N</th>
                <th className="text-right">MEAN</th>
                <th className="text-right">HIT</th>
              </tr>
            </thead>
            <tbody>
              {r.scorecard.map((row) => (
                <tr key={`${row.stance}-${row.horizonDays}`}>
                  <td>{row.stance}</td>
                  <td className="text-right">{row.horizonDays}d</td>
                  <td className="text-right">{row.n}</td>
                  <td className="text-right">{`${row.meanPct >= 0 ? '+' : '−'}${Math.abs(row.meanPct).toFixed(1)}%`}</td>
                  <td className="text-right">
                    {row.hits}/{row.n}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function NoteDialog({ note, onClose }: { note: Note; onClose: () => void }) {
  return (
    <DialogShell title={`RADAR NOTE · ${note.date}`} onClose={onClose} className="md:max-w-[760px]">
      <pre className="text-xs text-text-primary whitespace-pre-wrap break-words max-h-[60vh] overflow-y-auto">{note.markdown}</pre>
      {note.truncated && <p className="text-xs text-text-secondary">note truncated</p>}
      <div className="flex justify-end">
        <Button tier="ghost" onClick={onClose} data-autofocus>
          CLOSE
        </Button>
      </div>
    </DialogShell>
  )
}
