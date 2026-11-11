import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { CartesianGrid, Line, LineChart, ReferenceDot, ReferenceLine, ResponsiveContainer, XAxis, YAxis } from 'recharts'
import { AgeStamp, AsyncBody, Badge, Button, DataTable, EmptyBlock, MetricStat, PageContainer, Panel, PanelHeader, Segmented, SkeletonRows, StaleStrip, StatCell, StatusDot, type Column } from '../../components'
import { ClaimAge } from '../../components/intel'
import { sourceHref, SourceLink } from '../../components/intel/SourceLink'
import type { AgentRecord, AgentStatsResponse, TriageResponse } from '../../../shared/agentRecords'
import { MOVE_WINDOWS, WINDOW_HOURS, type MoveDetail, type MoveRow, type MovesResponse, type MoveWindow } from '../../../shared/moves'
import type { DefinitionsResponse } from '../../../shared/research'
import { fmtAge, fmtPx, fmtUsdCompact, signClass } from '../../lib/format'
import { coverageTreatment } from '../cockpit/logic'
import {
  attributionCell, attributionSegments, barScale, barWidth, BUCKET_LABEL, bestChecklist, betaPct, budgetLine, CHECK_LABEL, checkValue, checklistText, chartData, coverageCopy, crowdText, DASH,
  droppedTitle, falsifierLine, fmtPct, fmtZ, fundingZText, gradeLine, headerLine, investigateGate, isFactorCoin, layerChips, layerNote, liqSigmaText, metMark, NOT_A_FORECAST,
  outboundLinks, overBudgetLine, recordView, SORT_KEYS, SORT_LABEL, staleLine, studyLinkFor, tagText, trackLine, triageEmptyLabel, visibleItems, zWarn, type SortKey,
} from './logic'

// MOVES view (docs/design/README.md § MOVES, PLAN §2). Presentational: Moves.tsx owns the pollers, the URL and
// the actions. Explained-after-the-fact (D1, neutral and signed colours) and condition checks / agent
// hypotheses (D2, D6, info rule) are separate blocks. No APPROVE, KILL or order entry: OPEN, DISMISS,
// INVESTIGATE and outbound links only.

export interface Feed<T> {
  data: T | null
  loading: boolean
  error: string | null
  offline: string | null
  refetch: () => void
}

const LINK = 'text-xs text-text-secondary hover:text-text-primary underline-offset-2 hover:underline'
const LINK_BTN =
  'btn inline-flex items-center min-h-[var(--tap-min)] h-[var(--control-md)] px-2.5 text-xs border border-border text-text-secondary hover:text-text-primary hover:bg-hover rounded-control font-control [text-transform:var(--control-case)] tracking-[var(--control-tracking)]'
const WINDOW_OPTIONS = MOVE_WINDOWS.map((w) => ({ value: w, label: w.toUpperCase() }))
const SORT_OPTIONS = SORT_KEYS.map((k) => ({ value: k, label: SORT_LABEL[k] }))
const infoRule = 'border-l-2 border-info'

export interface MovesViewProps {
  window: MoveWindow
  onWindow: (w: MoveWindow) => void
  moves: Feed<MovesResponse>
  triage: Feed<TriageResponse>
  detail: Feed<MoveDetail>
  stats: AgentStatsResponse | null
  defs: DefinitionsResponse | null
  /** Rows after the sector filter, in display order. */
  rows: MoveRow[]
  sort: SortKey
  onSort: (k: SortKey) => void
  sector: string | null
  onSector: (id: string | null) => void
  selected: string | null
  onSelect: (coin: string) => void
  onBack: () => void
  showList: boolean
  showDetail: boolean
  now: number
  onDismiss: (id: string) => void
  onInvestigate: (coin: string) => void
  /** Coins with an investigation in flight, and the last failure's words. */
  busy: readonly string[]
  actionError: { coin: string; message: string } | null
}

export function MovesView(p: MovesViewProps) {
  return (
    <PageContainer className="pb-3 md:pb-[var(--gutter)] flex flex-col gap-3 min-w-0">
      {p.showList && (
        <>
          <MovesHeader moves={p.moves} window={p.window} onWindow={p.onWindow} />
          <FactorsPanel moves={p.moves} sector={p.sector} onSector={p.onSector} />
          <TriagePanel triage={p.triage} selected={p.selected} onOpen={p.onSelect} onDismiss={p.onDismiss} onInvestigate={p.onInvestigate} busy={p.busy} error={p.actionError} now={p.now} />
        </>
      )}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-3 min-w-0">
        {p.showList && (
          <section aria-label="moves table" className="lg:col-span-7 min-w-0">
            <MovesTablePanel moves={p.moves} rows={p.rows} sort={p.sort} onSort={p.onSort} sector={p.sector} onSector={p.onSector} selected={p.selected} onSelect={p.onSelect} now={p.now} />
          </section>
        )}
        {p.showDetail && (
          <section aria-label="selected coin" className="lg:col-span-5 min-w-0">
            <DetailPane {...p} />
          </section>
        )}
      </div>
    </PageContainer>
  )
}

// ─── Header ───

export function MovesHeader({ moves, window, onWindow }: { moves: Feed<MovesResponse>; window: MoveWindow; onWindow: (w: MoveWindow) => void }) {
  const m = moves.data
  const chips = m ? layerChips(m.layers) : []
  const notes = chips.filter((c) => c.dot !== 'ok' && c.reason)
  return (
    <header className="flex flex-col gap-1.5 pt-2 min-w-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <h1 className="label">MOVES</h1>
        <Segmented options={WINDOW_OPTIONS} value={window} onChange={onWindow} label="window" />
        {m ? (
          <span className={`text-xs tabular min-w-0 break-words ${m.state === 'ok' ? 'text-text-secondary' : 'text-amber'}`} title={m.universe.dropped.length > 0 ? droppedTitle(m.universe.dropped) : undefined}>
            {headerLine(m)}
          </span>
        ) : (
          moves.loading && <div className="h-3 w-48 bg-elevated pulse-label" />
        )}
        {chips.length > 0 && (
          <ul className="flex flex-wrap items-center gap-x-3 gap-y-1" aria-label="data layers">
            {chips.map((c) => (
              <li key={c.key} className="inline-flex items-center gap-1 text-xs text-text-secondary" title={c.reason ?? 'ok'}>
                <StatusDot status={c.dot} />
                {c.label}
              </li>
            ))}
          </ul>
        )}
      </div>
      {notes.map((c) => (
        <p key={c.key} className="text-xs text-text-secondary break-words">
          {c.label}: {c.reason}
        </p>
      ))}
    </header>
  )
}

// ─── A · Factors ───

export function FactorsPanel({ moves, sector, onSector }: { moves: Feed<MovesResponse>; sector: string | null; onSector: (id: string | null) => void }) {
  const m = moves.data
  return (
    <Panel>
      <PanelHeader title="FACTORS">
        {m?.sectorsAsOf && <AgeStamp generatedAt={m.sectorsAsOf} thresholdHours={24} />}
        <Link to="/sectors" className={LINK}>
          SECTORS →
        </Link>
      </PanelHeader>
      <AsyncBody
        loading={moves.loading}
        data={m}
        error={moves.error}
        offline={moves.offline}
        onRetry={moves.refetch}
        rows={2}
        empty={{ label: m?.state === 'unavailable' ? (m.reason ?? 'unavailable') : m?.state === 'pending' ? 'factors appear when the first run finishes' : 'no factor moves yet' }}
        isEmpty={(d) => d.factors.length === 0}
      >
        {(d) => (
          <ul className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6 gap-3 p-3">
            {d.factors.map((f) => {
              const id = f.id.startsWith('sector:') ? f.id.slice('sector:'.length) : null
              const active = id != null && id === sector
              const cell = (
                <StatCell label={f.label} className={signClass(f.pct)}>
                  {fmtPct(f.pct)} <span className="text-2xs text-text-secondary">n {f.n}</span>
                </StatCell>
              )
              return (
                <li key={f.id} className={`min-w-0 ${active ? 'bg-selected' : ''}`}>
                  {id ? (
                    <button type="button" className="text-left w-full min-h-[var(--tap-min)]" aria-pressed={active} title={active ? 'clear the sector filter' : `filter the table to ${f.label}`} onClick={() => onSector(active ? null : id)}>
                      {cell}
                    </button>
                  ) : (
                    cell
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </AsyncBody>
    </Panel>
  )
}

// ─── B · Triage ───

export function TriagePanel(p: {
  triage: Feed<TriageResponse>
  selected: string | null
  onOpen: (coin: string) => void
  onDismiss: (id: string) => void
  onInvestigate: (coin: string) => void
  busy: readonly string[]
  error: { coin: string; message: string } | null
  now: number
}) {
  const t = p.triage.data
  return (
    <Panel>
      <PanelHeader title={t && t.state === 'ok' ? `TRIAGE · ${budgetLine(t)}` : 'TRIAGE'}>
        {t && t.state === 'ok' && (
          <span className="text-xs tabular text-text-secondary" title="coins scanned in the latest run · agent investigations run today of the daily cap">
            {t.watched} watched · agents {t.agentRuns}/{t.agentCap}
          </span>
        )}
      </PanelHeader>
      <AsyncBody loading={p.triage.loading} data={t} error={p.triage.error} offline={p.triage.offline} onRetry={p.triage.refetch} rows={3}>
        {(d) => {
          if (d.state === 'unavailable') return <EmptyBlock label={d.reason ?? 'triage unavailable'} />
          const items = visibleItems(d.items)
          const over = overBudgetLine(d.overBudget)
          const blocked = d.agentBlockedReason
          return (
            <>
              {items.length === 0 ? (
                <EmptyBlock label={triageEmptyLabel(d)} />
              ) : (
                <ul>
                  {items.map((i) => {
                    const busy = p.busy.includes(i.coin)
                    const rv = recordView(i.record, busy)
                    const gate = investigateGate(blocked, busy)
                    return (
                      <li key={i.id} className={`flex flex-wrap items-start gap-x-3 gap-y-1.5 px-3 py-2 border-b border-border-subtle min-w-0 ${p.selected === i.coin ? 'bg-selected' : ''}`}>
                        <div className="flex-1 min-w-[12rem] flex flex-col gap-1">
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                            <span className="text-sm font-semibold text-text-primary">{i.coin}</span>
                            <span className="text-xs tabular text-text-secondary">{fmtAge(i.surfacedAt, p.now)}</span>
                          </div>
                          <p className="text-sm text-text-secondary break-words">{i.reason}</p>
                          <TriageRecord view={rv} record={i.record} />
                          {p.error?.coin === i.coin && (
                            <p role="alert" className="text-xs text-red-text">
                              {p.error.message}
                            </p>
                          )}
                        </div>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Button tier="ghost" className="min-h-[var(--tap-min)]" onClick={() => p.onOpen(i.coin)}>
                            OPEN
                          </Button>
                          <Button tier="ghost" className="min-h-[var(--tap-min)]" title="hide for today; it still counts against the budget" onClick={() => p.onDismiss(i.id)}>
                            DISMISS
                          </Button>
                          {i.record == null && (
                            <Button tier="ghost" className="min-h-[var(--tap-min)]" disabled={gate.disabled} title={gate.title} onClick={() => p.onInvestigate(i.coin)}>
                              INVESTIGATE
                            </Button>
                          )}
                        </div>
                      </li>
                    )
                  })}
                </ul>
              )}
              {blocked && items.some((i) => i.record == null) && <p className="px-3 py-1.5 text-xs text-text-secondary">INVESTIGATE off: {blocked}</p>}
              {over && <p className="px-3 py-1.5 text-xs tabular text-text-secondary">{over}</p>}
            </>
          )
        }}
      </AsyncBody>
    </Panel>
  )
}

function TriageRecord({ view, record }: { view: ReturnType<typeof recordView>; record: AgentRecord | null }) {
  if (view.kind === 'absent') return null
  if (view.kind === 'investigating') return <span className="text-xs text-info pulse-label">{view.text}</span>
  if (view.kind !== 'claim' || !record) return <span className="text-xs text-text-secondary">{view.text}</span>
  return (
    <div className={`${infoRule} pl-2 flex flex-col gap-0.5`}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <Badge tone="info">HYP</Badge>
        <Badge tone="info">{record.layer.replace('_', ' ').toUpperCase()}</Badge>
      </div>
      <p className="text-sm text-text-primary break-words">{record.claim}</p>
      {record.falsifier && <p className="text-xs text-text-secondary break-words">falsifier: {record.falsifier.text}</p>}
    </div>
  )
}

// ─── C · Table ───

function ResidualBar({ pct, scale }: { pct: number; scale: number }) {
  const w = barWidth(pct, scale)
  const pos = pct >= 0
  return (
    <span aria-hidden="true" className="relative inline-block h-2 w-14 bg-elevated flex-shrink-0" data-bar={w}>
      <span className="absolute inset-y-0 left-1/2 w-px bg-border" />
      <span className="absolute inset-y-0" style={{ width: `${w / 2}%`, [pos ? 'left' : 'right']: '50%', background: pos ? 'var(--color-mom-pos2)' : 'var(--color-mom-neg2)' }} />
    </span>
  )
}

const Dash = ({ title }: { title: string }) => (
  <span className="text-text-secondary" title={title}>
    {DASH}
  </span>
)

function columns(scale: number): Column<MoveRow>[] {
  const attr = <T,>(r: MoveRow, f: (a: NonNullable<MoveRow['attribution']>) => T, show: (v: T) => ReactNode) => {
    const none = attributionCell(r)
    return none ? <Dash title={none.title} /> : show(f(r.attribution!))
  }
  return [
    {
      key: 'coin', label: 'COIN', priority: 1,
      render: (r) => (
        <span className="font-semibold text-text-primary" title={r.sector?.label ?? undefined}>
          {r.coin}
        </span>
      ),
    },
    {
      key: 'total', label: 'TOTAL', priority: 2, align: 'right',
      render: (r) => attr(r, (a) => a.totalPct, (v) => <span className={signClass(v)} title="log-% over the window">{fmtPct(v)}</span>),
    },
    {
      key: 'beta', label: 'BETA', priority: 3, align: 'right',
      render: (r) => attr(r, (a) => betaPct(r.attribution), (v) => <span className="text-text-secondary" title="BTC + ETH ex-BTC contribution">{fmtPct(v)}</span>),
    },
    {
      key: 'sector', label: 'SECTOR', priority: 3, align: 'right',
      render: (r) => attr(r, (a) => a.sectorPct, (v) => (v == null ? <Dash title="no sector factor for this coin" /> : <span className="text-text-secondary">{fmtPct(v)}</span>)),
    },
    {
      key: 'residual', label: 'RESIDUAL', priority: 1, align: 'right',
      render: (r) =>
        attr(r, (a) => a.residualPct, (v) => (
          <span className="inline-flex items-center justify-end gap-2" title="total minus beta and sector: unexplained, not a cause">
            <ResidualBar pct={v} scale={scale} />
            <span className={`${signClass(v)} w-12 text-right`}>{fmtPct(v)}</span>
          </span>
        )),
    },
    {
      key: 'z', label: 'Z', priority: 1, align: 'right',
      render: (r) => attr(r, (a) => a.residualZ, (v) => <span className={zWarn(v) ? 'text-amber' : 'text-text-primary'} title="residual z: Σ residual / (σ1h · √hours)">{fmtZ(v)}</span>),
    },
    {
      key: 'tags', label: 'TAGS', priority: 4,
      render: (r) =>
        attr(r, (a) => a, (a) => {
          const flow = tagText(a.flowHours, 'FLOW')
          const news = tagText(a.newsHours, 'NEWS')
          if (a.flowHours == null && a.newsHours == null) return <Dash title="flow and news layers unavailable" />
          if (!flow && !news) return <span className="text-xs text-text-secondary">none</span>
          return (
            <span className="inline-flex gap-1">
              {flow && <Badge tone="gray">{flow}</Badge>}
              {news && <Badge tone="gray">{news}</Badge>}
            </span>
          )
        }),
    },
    { key: 'crowd', label: 'CROWD L/S', priority: 3, render: (r) => <span title="crowding checks met, long · short">{crowdText(r.positioning)}</span> },
    {
      key: 'liq', label: 'LIQ σ', priority: 4, align: 'right',
      render: (r) => (r.liq.state.state === 'unavailable' ? <Dash title={r.liq.state.reason ?? 'liquidation layer unavailable'} /> : <span title="nearest cluster, in 24h sigmas">{liqSigmaText(r.liq)}</span>),
    },
    {
      key: 'check', label: 'CHECK', priority: 4,
      render: (r) => {
        const b = bestChecklist(r.setups)
        return b ? <Badge tone="info">{checklistText(b)}</Badge> : <Dash title="no checklist could be evaluated" />
      },
    },
  ]
}

export function MovesTablePanel(p: { moves: Feed<MovesResponse>; rows: MoveRow[]; sort: SortKey; onSort: (k: SortKey) => void; sector: string | null; onSector: (id: string | null) => void; selected: string | null; onSelect: (coin: string) => void; now: number }) {
  const m = p.moves.data
  const sectorLabel = p.sector ? (m?.rows.find((r) => r.sector?.id === p.sector)?.sector?.label ?? p.sector) : null
  const cols = columns(barScale(p.rows))
  return (
    <Panel>
      <PanelHeader title={`MOVES · BY ${SORT_LABEL[p.sort]}`}>
        {sectorLabel && (
          <Button tier="ghost" onClick={() => p.onSector(null)} aria-label={`clear the ${sectorLabel} filter`}>
            {sectorLabel.toUpperCase()} ×
          </Button>
        )}
        <Segmented options={SORT_OPTIONS} value={p.sort} onChange={p.onSort} label="sort" />
      </PanelHeader>
      {m && m.state === 'ok' && (() => {
        const stale = staleLine(m.asOf, p.now)
        return stale ? <StaleStrip>{stale}</StaleStrip> : null
      })()}
      <AsyncBody
        loading={p.moves.loading}
        data={m}
        error={p.moves.error}
        offline={p.moves.offline}
        onRetry={p.moves.refetch}
        skeleton={<SkeletonRows rows={10} />}
      >
        {(d) => {
          if (d.state === 'pending') return <EmptyBlock label={headerLine(d)} />
          if (d.state === 'unavailable') return <EmptyBlock label={d.reason ?? 'unavailable'} />
          if (p.rows.length === 0) {
            return <EmptyBlock label={p.sector ? `no coins in ${sectorLabel}` : 'no coin has enough history for this window'} action={p.sector ? { label: 'SHOW ALL', onClick: () => p.onSector(null) } : undefined} />
          }
          return (
            <div data-moves>
              <DataTable columns={cols} rows={p.rows} rowKey={(r) => r.coin} onRowClick={(r) => p.onSelect(r.coin)} isSelected={(r) => r.coin === p.selected} />
            </div>
          )
        }}
      </AsyncBody>
    </Panel>
  )
}

// ─── D · Detail ───

export function ActionBar({ row, defs }: { row: Pick<MoveRow, 'coin' | 'opportunityId' | 'setups'>; defs: DefinitionsResponse | null }) {
  return (
    <nav
      aria-label={`${row.coin} links`}
      className="order-first max-lg:order-last max-lg:sticky max-lg:bottom-0 flex flex-wrap items-center gap-1.5 px-3 py-2 bg-panel border-t border-border-subtle lg:border-t-0 lg:border-b pb-[max(0.5rem,env(safe-area-inset-bottom))] lg:pb-2"
    >
      {outboundLinks(row, defs).map((l) => (
        <Link key={l.key} to={l.to} title={l.title} className={LINK_BTN}>
          {l.label} →
        </Link>
      ))}
    </nav>
  )
}

function DetailPane(p: MovesViewProps) {
  const coin = p.selected
  return (
    <Panel>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 border-b border-border-subtle">
        <Button tier="ghost" className="lg:hidden min-h-[var(--tap-min)]" onClick={p.onBack}>
          ← MOVES
        </Button>
        <h2 className="text-lg font-semibold text-text-primary">{coin ?? DASH}</h2>
        {p.detail.data && (
          <span className="text-xs tabular text-text-secondary">
            {p.detail.data.sector?.label ?? 'no sector'} · mark {fmtPx(p.detail.data.mark)} · {p.window}
          </span>
        )}
      </div>
      {coin == null ? (
        <EmptyBlock label="select a coin" />
      ) : (
        <AsyncBody loading={p.detail.loading} data={p.detail.data} error={p.detail.error} offline={p.detail.offline} onRetry={p.detail.refetch} rows={6}>
          {(d) =>
            d.state === 'unavailable' ? (
              <EmptyBlock label={d.reason ?? `${coin} detail unavailable`} />
            ) : (
              <div className="flex flex-col">
                <ActionBar row={d} defs={p.defs} />
                <AttributionBlock d={d} />
                <RecordBlock d={d} stats={p.stats} busy={p.busy.includes(d.coin)} onInvestigate={p.onInvestigate} error={p.actionError?.coin === d.coin ? p.actionError.message : null} blocked={p.triage.data?.agentBlockedReason ?? null} />
                <PositioningBlock d={d} />
                <LiqBlock d={d} />
                <AttentionBlock d={d} />
                <ChecklistBlock d={d} defs={p.defs} />
              </div>
            )
          }
        </AsyncBody>
      )}
    </Panel>
  )
}

function Section({ id, title, children, info }: { id: string; title: string; children: ReactNode; info?: boolean }) {
  return (
    <section aria-labelledby={id} data-block={id} className={`flex flex-col border-t border-border-subtle ${info ? infoRule : ''}`}>
      <h3 id={id} className={`label px-3 py-1.5 ${info ? '!text-info bg-info-bg' : ''}`}>
        {title}
      </h3>
      <div className="flex flex-col gap-2 px-3 py-2 min-w-0">{children}</div>
    </section>
  )
}

const SEG_CLASS = { beta: 'bg-text-secondary/40', flow: '', news: '', other: '' } as const
const segColor = (kind: keyof typeof SEG_CLASS, pct: number) => (kind === 'beta' ? undefined : pct >= 0 ? 'var(--color-mom-pos2)' : 'var(--color-mom-neg2)')

function AttributionBlock({ d }: { d: MoveDetail }) {
  const a = d.attribution
  return (
    <Section id="d1" title="ATTRIBUTION · EXPLAINED AFTER THE FACT">
      {!a ? (
        <p className="text-sm text-text-secondary">{d.attributionReason ?? 'no attribution for this window'}</p>
      ) : isFactorCoin(d.coin) ? (
        <div className="flex flex-col gap-1">
          <p className="text-sm text-text-secondary">BTC is the factor: total only.</p>
          <StatCell label={`TOTAL · ${a.window} · log-%`} className={signClass(a.totalPct)}>
            {fmtPct(a.totalPct)} <span className="text-2xs text-text-secondary">n {a.hours} h</span>
          </StatCell>
        </div>
      ) : (
        <>
          <div role="img" aria-label="attribution bar" className="flex h-3 w-full bg-elevated overflow-hidden">
            {attributionSegments(a).map((s) => (
              <span key={s.key} data-seg={s.key} title={`${s.label} ${fmtPct(s.pct)}`} className={SEG_CLASS[s.kind]} style={{ width: `${s.width}%`, background: segColor(s.kind, s.pct), opacity: s.key === 'eth' ? 0.7 : 1 }} />
            ))}
          </div>
          <ul className="grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-0.5 text-xs tabular">
            {attributionSegments(a).map((s) => (
              <li key={s.key} className="flex justify-between gap-2">
                <span className="text-text-secondary">{s.label}</span>
                <span className={signClass(s.pct)}>
                  {fmtPct(s.pct)}
                  {s.kind === 'flow' && a.flowHours != null && ` · ${a.flowHours}h`}
                  {s.kind === 'news' && a.newsHours != null && ` · ${a.newsHours}h`}
                </span>
              </li>
            ))}
            {a.residualFlowPct == null && (
              <li className="flex justify-between gap-2 sm:col-span-2" title={d.layers.flow.reason ?? undefined}>
                <span className="text-text-secondary">RESIDUAL {BUCKET_LABEL.flow}</span>
                <span className="text-text-secondary">{DASH} {d.layers.flow.reason ?? 'flow layer unavailable'}</span>
              </li>
            )}
            {a.residualNewsPct == null && (
              <li className="flex justify-between gap-2 sm:col-span-2" title={d.layers.attention.reason ?? undefined}>
                <span className="text-text-secondary">RESIDUAL {BUCKET_LABEL.news}</span>
                <span className="text-text-secondary">{DASH} {d.layers.attention.reason ?? 'news layer unavailable'}</span>
              </li>
            )}
          </ul>
          <p className="text-2xs text-text-secondary">Residual buckets split the unexplained part by hour. They are not causes.</p>
          <div className="table-scroll">
            <table className="dt w-full text-xs tabular border-collapse">
              <thead>
                <tr className="border-b border-border">
                  <th className="px-2 py-1 label text-left">FACTOR</th>
                  <th className="px-2 py-1 label text-right">β</th>
                  <th className="px-2 py-1 label text-right">CONTRIB</th>
                  <th className="px-2 py-1 label text-right">N</th>
                </tr>
              </thead>
              <tbody>
                {a.betas.map((b) => (
                  <tr key={b.factor} className="border-b border-border-subtle" title={b.reason ?? undefined}>
                    <td className="px-2 py-1">{b.factor}</td>
                    <td className="px-2 py-1 text-right">{b.beta == null ? DASH : b.beta.toFixed(2)}</td>
                    <td className={`px-2 py-1 text-right ${signClass(b.contributionPct)}`}>{fmtPct(b.contributionPct)}</td>
                    <td className="px-2 py-1 text-right">{b.n}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {a.betas.filter((b) => b.reason).map((b) => (
            <p key={b.factor} className="text-xs text-text-secondary">
              {b.factor}: {b.reason}
            </p>
          ))}
          <p className="text-xs tabular text-text-secondary">
            R² {a.r2 == null ? DASH : a.r2.toFixed(2)} · estimation {a.estimation.from.slice(0, 16).replace('T', ' ')} → {a.estimation.to.slice(0, 16).replace('T', ' ')} UTC (n {a.estimation.n}) · σ1h resid {a.sigma1hPct == null ? DASH : `${a.sigma1hPct.toFixed(2)}%`} · z {fmtZ(a.residualZ)}
          </p>
          <AttributionChart d={d} />
        </>
      )}
    </Section>
  )
}

const tickTime = (t: number, w: MoveWindow) => {
  const iso = new Date(t).toISOString()
  return WINDOW_HOURS[w] > 24 ? `${iso.slice(5, 10)} ${iso.slice(11, 13)}h` : `${iso.slice(11, 13)}:00`
}

function AttributionChart({ d }: { d: MoveDetail }) {
  const { points, marks } = chartData(d.series)
  if (points.length === 0) return null
  return (
    <figure aria-label={`cumulative ${d.coin} move against its beta-fitted path`} className="flex flex-col gap-1">
      <div className="h-[220px] md:h-[280px] min-w-0">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={points} margin={{ top: 8, right: 12, left: 4, bottom: 4 }}>
            <CartesianGrid stroke="var(--color-border-subtle)" vertical={false} />
            <XAxis dataKey="t" type="number" domain={['dataMin', 'dataMax']} tickFormatter={(t: number) => tickTime(t, d.window)} tick={{ fontSize: 10, fill: 'var(--color-text-secondary)' }} stroke="var(--color-border)" />
            <YAxis tickFormatter={(v: number) => `${v.toFixed(1)}%`} tick={{ fontSize: 10, fill: 'var(--color-text-secondary)' }} stroke="var(--color-border)" width={44} />
            <ReferenceLine y={0} stroke="var(--color-border)" strokeDasharray="3 3" />
            <Line type="monotone" dataKey="actual" name="actual" dot={false} stroke="var(--color-text-primary)" strokeWidth={1.5} isAnimationActive={false} />
            <Line type="monotone" dataKey="fitted" name="beta-fitted" dot={false} stroke="var(--color-text-secondary)" strokeDasharray="4 3" strokeWidth={1.5} isAnimationActive={false} />
            {marks.map((m) => (
              <ReferenceDot key={`${m.kind}-${m.t}`} x={m.t} y={m.y} r={3} fill={m.kind === 'flow' ? 'var(--color-amber)' : 'var(--color-info)'} stroke="none" ifOverflow="visible" />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <figcaption className="text-2xs text-text-secondary">solid: actual · dashed: beta-fitted (cumulative log-%) · amber dot: OI-drop hour · blue dot: news hour</figcaption>
    </figure>
  )
}

export function RecordBlock({ d, stats, busy, onInvestigate, error, blocked }: { d: MoveDetail; stats: AgentStatsResponse | null; busy: boolean; onInvestigate: (coin: string) => void; error: string | null; blocked: string | null }) {
  const r = d.record
  const gate = investigateGate(blocked ?? (d.layers.agents.state === 'unavailable' ? d.layers.agents.reason : null), busy)
  return (
    <Section id="d2" title="AGENT RECORD · HYPOTHESIS" info>
      <p className="text-2xs text-info">{NOT_A_FORECAST}</p>
      {r ? (
        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Badge tone="info">HYP</Badge>
            <Badge tone="info">{r.layer.replace('_', ' ').toUpperCase()}</Badge>
            <Badge tone="gray">{r.status.replace('_', ' ').toUpperCase()}</Badge>
            {r.direction && <span className="text-xs text-text-secondary">{r.direction.toUpperCase()} · {r.horizonHours}h</span>}
          </div>
          {r.status === 'no_cause' ? <p className="text-sm text-text-secondary">no cause found</p> : <p className="text-sm text-text-primary break-words">{r.claim}</p>}
          {r.falsifier && <p className="text-xs text-text-secondary break-words">falsifier: {falsifierLine(r.falsifier, d.mark)}</p>}
          {r.sources.length > 0 && (
            <ul className="flex flex-col gap-1">
              {r.sources.map((s) => (
                <li key={s.url} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 min-w-0">
                  <SourceLink source={{ label: s.title || new URL(s.url).hostname, url: s.url }} />
                  {s.ts && <ClaimAge ts={s.ts} />}
                  {!s.observed && <span className="text-xs text-amber" title="the provider's citations do not print this source">unverified</span>}
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs tabular text-text-secondary">{gradeLine(r)}</p>
          {r.dropped > 0 && <p className="text-xs text-text-secondary">{r.dropped} lines dropped by the number check</p>}
          <p className="text-xs tabular text-text-secondary">created {fmtAge(r.createdAt)} · {r.trigger}{r.model ? ` · ${r.model}` : ''}</p>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <p className="text-sm text-text-secondary">no record — residual below the bar</p>
          <Button tier="ghost" className="min-h-[var(--tap-min)]" disabled={gate.disabled} title={gate.title} onClick={() => onInvestigate(d.coin)}>
            INVESTIGATE
          </Button>
          {gate.disabled && <span className="text-xs text-text-secondary">{gate.title}</span>}
        </div>
      )}
      {error && (
        <p role="alert" className="text-xs text-red-text">
          {error}
        </p>
      )}
      <p className="text-xs tabular text-text-secondary border-t border-border-subtle pt-1.5">{trackLine(stats, r?.horizonHours ?? WINDOW_HOURS[d.window])}</p>
    </Section>
  )
}

function PositioningBlock({ d }: { d: MoveDetail }) {
  const p = d.positioning
  return (
    <Section id="d3" title="POSITIONING (NOW)">
      <div className="grid grid-cols-2 md:grid-cols-3 gap-x-2">
        <MetricStat label="FUNDING APR" value={fmtPct(p.fundingAprPct)} delta={fundingZText(p)} />
        <MetricStat label="PREMIUM" value={p.premiumBps == null ? DASH : `${p.premiumBps.toFixed(1)}bp`} />
        <MetricStat label="OI" value={fmtUsdCompact(p.oiUsd)} delta={`n ${p.oiN}`} />
        <MetricStat label="ΔOI 24H" value={fmtPct(p.oiChg24hPct)} delta={`n ${p.oiN}`} />
        <MetricStat label="ΔOI 72H" value={fmtPct(p.oiChg72hPct)} delta={`n ${p.oiN}`} />
        <MetricStat label="OI / VOLUME" value={p.oiToVolume == null ? DASH : p.oiToVolume.toFixed(2)} />
      </div>
      <div className="table-scroll">
        <table className="dt w-full text-xs tabular border-collapse">
          <thead>
            <tr className="border-b border-border">
              <th className="px-2 py-1 label text-left">CROWDING CHECK</th>
              <th className="px-2 py-1 label text-left">SIDE</th>
              <th className="px-2 py-1 label text-right">VALUE</th>
              <th className="px-2 py-1 label text-right">THRESHOLD</th>
              <th className="px-2 py-1 label text-right">MET</th>
            </tr>
          </thead>
          <tbody>
            {p.checks.map((c) => (
              <tr key={`${c.key}-${c.side}`} className="border-b border-border-subtle">
                <td className="px-2 py-1">{CHECK_LABEL[c.key]}</td>
                <td className="px-2 py-1 text-text-secondary">{c.side}</td>
                <td className="px-2 py-1 text-right">{checkValue(c.key, c.value)}</td>
                <td className="px-2 py-1 text-right text-text-secondary">≥ {checkValue(c.key, c.threshold)}</td>
                <td className="px-2 py-1 text-right" title={c.met == null ? 'not enough history to evaluate' : undefined}>{metMark(c.met)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs tabular text-text-secondary">met long {p.longMet} of {p.of} · short {p.shortMet} of {p.of}</p>
    </Section>
  )
}

function ClusterLine({ side, c, sigmas }: { side: string; c: { priceLo: number; priceHi: number; distancePct: number; notionalUsd: number } | null; sigmas: number | null }) {
  return (
    <li className="flex flex-wrap justify-between gap-x-3 text-xs tabular">
      <span className="text-text-secondary">nearest {side}</span>
      {c ? (
        <span>
          {fmtPx((c.priceLo + c.priceHi) / 2)} · {fmtPct(side === 'long' ? -c.distancePct : c.distancePct)} · {sigmas == null ? `${DASH} σ` : `${sigmas.toFixed(1)}σ`} · {fmtUsdCompact(c.notionalUsd)}
        </span>
      ) : (
        <span className="text-text-secondary">{DASH} none mapped</span>
      )}
    </li>
  )
}

function LiqBlock({ d }: { d: MoveDetail }) {
  const l = d.liq
  const cov = coverageCopy(l.coverageRatio)
  return (
    <Section id="d4" title="LIQUIDATION PROXIMITY">
      {l.state.state === 'unavailable' ? (
        <p className="text-sm text-text-secondary">{l.state.reason ?? 'needs the always-on scanner and crawler'}</p>
      ) : (
        <>
          {coverageTreatment(l.coverageRatio) === 'none' ? (
            <p className="text-sm text-amber">{cov.text}</p>
          ) : (
            <>
              <ul className="flex flex-col gap-0.5">
                <ClusterLine side="long" c={l.nearestLong} sigmas={l.longSigmas} />
                <ClusterLine side="short" c={l.nearestShort} sigmas={l.shortSigmas} />
              </ul>
              <p className={`text-xs ${cov.kind === 'partial' ? 'text-amber' : 'text-text-secondary'}`}>{cov.text}{l.sigma24hPct != null && ` · σ24h ${l.sigma24hPct.toFixed(2)}%`}</p>
            </>
          )}
        </>
      )}
    </Section>
  )
}

function AttentionBlock({ d }: { d: MoveDetail }) {
  const a = d.attention
  const note = layerNote(a.state, 'needs a database (news and Elfa are stored)')
  return (
    <Section id="d5" title="ATTENTION">
      {a.state.state === 'unavailable' ? (
        <p className="text-sm text-text-secondary">{note}</p>
      ) : (
        <>
          <p className="text-xs tabular text-text-secondary">
            news 24h {a.news24h ?? DASH} vs 7d daily mean {a.newsDailyMean7d == null ? DASH : a.newsDailyMean7d.toFixed(1)} · ratio {a.newsRatio == null ? DASH : `${a.newsRatio.toFixed(1)}×`} · 72h {a.news72h ?? DASH}
          </p>
          <p className="text-xs tabular text-text-secondary">
            Elfa mentions 24h {a.mentions24h ?? DASH} · Δ {fmtPct(a.mentionsChg24hPct, 0)}
            {a.mentionsAsOf ? ` · as of ${a.mentionsAsOf.slice(0, 16).replace('T', ' ')} UTC` : ''}
          </p>
          {a.sectorStage && (
            <p className="text-xs text-text-secondary">
              sector {d.sector?.label ?? a.sectorId}: <Badge tone="gray">{a.sectorStage.toUpperCase()}</Badge>{' '}
              <Link to="/sectors" className={LINK}>
                SECTORS →
              </Link>
            </p>
          )}
          {note && <p className="text-xs text-text-secondary">{note}</p>}
        </>
      )}
      {d.headlines.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {d.headlines.slice(0, 5).map((h) => {
            const href = sourceHref(h.url ?? undefined)
            return (
              <li key={`${h.firstSeen}-${h.title}`} className="flex flex-wrap items-baseline gap-x-2 text-xs min-w-0">
                {href?.kind === 'external' ? (
                  <a href={href.href} target="_blank" rel="noopener noreferrer" className="text-text-primary hover:underline break-words min-w-0">
                    {h.title} ↗
                  </a>
                ) : (
                  <span className="text-text-primary break-words min-w-0">{h.title}</span>
                )}
                <ClaimAge ts={h.firstSeen} />
              </li>
            )
          })}
        </ul>
      ) : (
        a.state.state !== 'unavailable' && <p className="text-xs text-text-secondary">no headlines (guests see none)</p>
      )}
    </Section>
  )
}

function ChecklistBlock({ d, defs }: { d: MoveDetail; defs: DefinitionsResponse | null }) {
  return (
    <Section id="d6" title={NOT_A_FORECAST} info>
      {d.setups.length === 0 ? (
        <p className="text-sm text-text-secondary">no checklist for this coin</p>
      ) : (
        d.setups.map((s) => {
          const study = studyLinkFor(defs, s.definitionId, d.coin)
          return (
            <div key={s.kind} className="flex flex-col gap-1" data-checklist={s.kind}>
              <p className="text-xs text-text-primary">
                {s.kind.toUpperCase()} · side {s.side ?? DASH} · met {s.met} of {s.of}
              </p>
              <ul className="flex flex-col gap-0.5">
                {s.checks.map((c) => (
                  <li key={c.key} className="grid grid-cols-[1fr_auto_auto_1.5rem] gap-x-3 text-xs tabular">
                    <span className="text-text-secondary">{c.label}</span>
                    <span>{c.value == null ? DASH : typeof c.value === 'number' ? c.value.toFixed(2) : c.value}</span>
                    <span className="text-text-secondary">{c.threshold}</span>
                    <span className="text-right" title={c.met == null ? 'not enough data to evaluate' : undefined}>{metMark(c.met)}</span>
                  </li>
                ))}
              </ul>
              <p className="text-xs text-text-secondary">
                {s.definitionId ? (
                  <>
                    tested as: {s.definitionId} (daily version){' '}
                    {study && (
                      <Link to={study} className={LINK}>
                        STUDY →
                      </Link>
                    )}
                  </>
                ) : (
                  'untested — attention is not a Lab metric'
                )}
              </p>
            </div>
          )
        })
      )}
      <p className="text-2xs text-text-secondary">Thresholds are starting points, not fitted values.</p>
    </Section>
  )
}
