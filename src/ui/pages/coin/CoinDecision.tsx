import { lazy, Suspense, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router'
import { AsyncBody, Badge, Button, PageContainer, Panel, Segmented, SkeletonRows } from '../../components'
import { FundingPanel, PerpHeader, usePerpStats } from '../../components/market/PerpPanels'
import type { AgentStatsResponse } from '../../../shared/agentRecords'
import { MOVE_WINDOWS, type MoveWindow } from '../../../shared/moves'
import type { QueueItem } from '../../../shared/queue'
import type { DefinitionsResponse } from '../../../shared/research'
import { isTimeframe, type Timeframe } from '../../../shared/timeframes'
import { ApiError } from '../../lib/api'
import { fmtPx } from '../../lib/format'
import { useNow, useQueryPatch } from '../../lib/hooks'
import { moves } from '../../lib/moves'
import { usePoll } from '../../lib/poll'
import { research } from '../../lib/research'
import { investigateGate, parseWindow } from '../moves/logic'
import { AttentionBlock, AttributionBlock, ChecklistBlock, LiqBlock, PositioningBlock, RecordBlock, type Feed } from '../moves/MovesView'
import { useInvestigate, type ActionError } from '../moves/useInvestigate'
import {
  coinActions, detailOutcome, hip3Reason, isHip3, opportunityId, parseChart, queueHeadline, queuePartsLine, rejectedDetail, type ChartView, type DetailOutcome,
} from './logic'
import { SetupApprove } from './Approve'

// COIN — the decide page (PLAN2 §2.3/§2.4), route `/coin/:coin` and the QUEUE's right pane (layout='pane').
// Top to bottom: why it moved, is it priced in, is attention rising or saturated, the ENTER/FADE checklist, what
// the agent claimed and what would falsify it; then the actions. A missing layer is one quiet reason line in
// place. A ready opportunity is decided here: the SETUP block (Approve.tsx) carries APPROVE and REJECT behind the
// ticket dialog, with the feed's gates. The liquidation map is not on this page.

export interface CoinDecisionProps {
  coin: string
  /** The coin's queue item when it is in today's queue (home passes it; CoinPage looks it up). */
  item?: QueueItem | null
  /** Why an investigation cannot run (QueueResponse.agentBlockedReason); null when it can. */
  blocked?: string | null
  /** pane: one column, no ← QUEUE (home right pane). page: the /coin route. */
  layout?: 'page' | 'pane'
}

const POLL_MS = 60_000
const STATS_MS = 300_000
const DEFAULT_TF: Timeframe = '1d'

/** Container: the pollers (detail 60 s, record stats 5 min, definitions once), `?window/chart/tf`, INVESTIGATE. */
export function CoinDecision({ coin, item, blocked = null, layout = 'page' }: CoinDecisionProps) {
  const [params] = useSearchParams()
  const patch = useQueryPatch()
  const now = useNow(30_000)
  const win = parseWindow(params.get('window'))
  const chart = parseChart(params.get('chart'))
  const tfParam = params.get('tf')
  const tf: Timeframe = isTimeframe(tfParam) ? tfParam : DEFAULT_TF
  const hip3 = isHip3(coin)

  const detail = usePoll(
    async (): Promise<DetailOutcome> => {
      try {
        return detailOutcome(await moves.detail(coin, win))
      } catch (e) {
        const r = e instanceof ApiError ? rejectedDetail(e.status, e.message, coin) : null
        if (r) return r
        throw e
      }
    },
    [coin, win],
    { intervalMs: POLL_MS, enabled: coin !== '' && !hip3 },
  )
  const stats = usePoll(moves.stats, [], { intervalMs: STATS_MS, enabled: !hip3, cacheKey: 'moves.stats' })
  const defs = usePoll(research.definitions, [], { intervalMs: null, enabled: !hip3, cacheKey: 'research.definitions' })
  const inv = useInvestigate(() => detail.refetch())

  const feed: Feed<DetailOutcome> = hip3
    ? { data: { detail: null, reason: hip3Reason(coin) }, loading: false, error: null, offline: null, refetch: () => {} }
    : detail

  return (
    <CoinDecisionView
      coin={coin}
      item={item}
      blocked={hip3 ? hip3Reason(coin) : blocked}
      layout={layout}
      window={win}
      onWindow={(w) => patch({ window: w === '24h' ? null : w })}
      chart={chart}
      onChart={(c) => patch({ chart: c === 'move' ? null : c })}
      tf={tf}
      onTf={(t) => patch({ tf: t === DEFAULT_TF ? null : t })}
      detail={feed}
      stats={stats.data}
      defs={defs.data}
      now={now}
      busy={inv.busy.includes(coin)}
      actionError={inv.actionError?.coin === coin ? inv.actionError : null}
      onInvestigate={(c) => void inv.investigate(c)}
      onAsk={() => globalThis.dispatchEvent(new Event('ht:ask'))}
      setup={(oppId) => <SetupApprove key={oppId} oppId={oppId} onDecided={() => detail.refetch()} />}
    />
  )
}

const LINK = 'text-xs text-text-secondary hover:text-text-primary underline-offset-2 hover:underline'
const LINK_BTN =
  'btn inline-flex items-center min-h-[var(--tap-min)] h-[var(--control-md)] px-2.5 text-xs border border-border text-text-secondary hover:text-text-primary hover:bg-hover rounded-control font-control [text-transform:var(--control-case)] tracking-[var(--control-tracking)]'
const WINDOW_OPTIONS = MOVE_WINDOWS.map((w) => ({ value: w, label: w.toUpperCase() }))
const CHART_OPTIONS: { value: ChartView; label: string }[] = [
  { value: 'move', label: 'MOVE' },
  { value: 'price', label: 'PRICE' },
]

export interface CoinDecisionViewProps {
  coin: string
  item: QueueItem | null | undefined
  blocked: string | null
  layout: 'page' | 'pane'
  window: MoveWindow
  onWindow: (w: MoveWindow) => void
  chart: ChartView
  onChart: (c: ChartView) => void
  tf: Timeframe
  onTf: (tf: Timeframe) => void
  detail: Feed<DetailOutcome>
  stats: AgentStatsResponse | null
  defs: DefinitionsResponse | null
  now: number
  busy: boolean
  actionError: ActionError | null
  onInvestigate: (coin: string) => void
  onAsk: () => void
  /** The SETUP block for a ready opportunity (the container passes the live one; tests pass a stub or nothing). */
  setup?: (oppId: string) => ReactNode
}

/** Presentational: header, IN QUEUE, actions, then the decision blocks (two columns on the page from lg). */
export function CoinDecisionView(p: CoinDecisionViewProps) {
  const page = p.layout === 'page'
  const d = p.detail.data?.detail ?? null
  const reason = p.detail.data?.reason ?? null
  const blocked = p.blocked ?? (d && d.layers.agents.state === 'unavailable' ? d.layers.agents.reason : null)
  const oppId = opportunityId(p.item, d)
  const body = (
    <>
      <Panel>
        <CoinHeader {...p} />
        <QueueParts item={p.item} coin={p.coin} now={p.now} />
        <Actions {...p} blocked={blocked} hasDetail={d != null} />
        {oppId && p.setup?.(oppId)}
      </Panel>
      <div className={`grid grid-cols-1 gap-3 min-w-0 ${page ? 'lg:grid-cols-12' : ''}`}>
        <div className={`flex flex-col gap-3 min-w-0 ${page ? 'lg:col-span-7' : ''}`}>
          <Panel>
            <Group id="why" title="WHY IT MOVED" controls={<Segmented options={CHART_OPTIONS} value={p.chart} onChange={p.onChart} label="chart" />}>
              {p.chart === 'price' ? (
                <>
                  {reason && <ReasonLine text={reason} />}
                  <PriceView coin={p.coin} tf={p.tf} onTf={p.onTf} />
                </>
              ) : (
                <AsyncBody loading={p.detail.loading} data={p.detail.data} error={p.detail.error} offline={p.detail.offline} onRetry={p.detail.refetch} rows={6}>
                  {(o) => (o.detail ? <AttributionBlock d={o.detail} /> : <ReasonLine text={o.reason} />)}
                </AsyncBody>
              )}
            </Group>
          </Panel>
          {d && (
            <Panel>
              <RecordBlock d={d} stats={p.stats} busy={p.busy} onInvestigate={p.onInvestigate} error={p.actionError?.message ?? null} blocked={blocked} />
            </Panel>
          )}
        </div>
        {d && (
          <div className={`flex flex-col gap-3 min-w-0 ${page ? 'lg:col-span-5' : ''}`}>
            <Panel>
              <Group id="priced" title="PRICED IN">
                <PositioningBlock d={d} />
                <LiqBlock d={d} />
              </Group>
            </Panel>
            <Panel>
              <AttentionBlock d={d} />
            </Panel>
            <Panel>
              <Group id="enterfade" title="ENTER / FADE">
                <ChecklistBlock d={d} defs={p.defs} />
              </Group>
            </Panel>
          </div>
        )}
      </div>
    </>
  )
  return page ? (
    <PageContainer className="pb-3 md:pb-[var(--gutter)] flex flex-col gap-3 min-w-0">{body}</PageContainer>
  ) : (
    <div className="flex flex-col gap-3 min-w-0" data-layout="pane">
      {body}
    </div>
  )
}

function CoinHeader(p: CoinDecisionViewProps) {
  const d = p.detail.data?.detail ?? null
  const Title = p.layout === 'page' ? 'h1' : 'h2'
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2 border-b border-border-subtle">
      {p.layout === 'page' && (
        <Link to={`/queue?coin=${encodeURIComponent(p.coin)}`} className={LINK_BTN}>
          ← QUEUE
        </Link>
      )}
      <Title className="text-lg font-semibold text-text-primary break-all">{p.coin}</Title>
      {d && (
        <span className="text-xs tabular text-text-secondary">
          {d.sector?.label ?? 'no sector'} · mark {fmtPx(d.mark)} · {p.window}
        </span>
      )}
      <Segmented options={WINDOW_OPTIONS} value={p.window} onChange={p.onWindow} label="window" />
    </div>
  )
}

function QueueParts({ item, coin, now }: { item: QueueItem | null | undefined; coin: string; now: number }) {
  const head = queueHeadline(item, now)
  if (head == null) return null
  const parts = queuePartsLine(item, coin)
  return (
    <div className="flex flex-col gap-1 px-3 py-2 border-b border-border-subtle min-w-0" data-block="inqueue">
      <p className={`text-xs tabular ${item ? 'label' : 'text-text-secondary'}`}>{head}</p>
      {parts.length > 0 && (
        <ul className="flex flex-col gap-1">
          {parts.map((l) => (
            <li key={l.key} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs min-w-0">
              <Badge tone="gray">{l.label}</Badge>
              {l.direction && <span className="text-text-secondary">{l.direction}</span>}
              <span className="text-text-primary break-words min-w-0">{l.reason}</span>
              {l.to && (
                <Link to={l.to} className={LINK}>
                  →
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function Actions(p: CoinDecisionViewProps & { hasDetail: boolean }) {
  const d = p.detail.data?.detail ?? null
  const gate = investigateGate(p.blocked, p.busy)
  return (
    <div className="flex flex-col gap-1 px-3 py-2">
      <nav aria-label={`${p.coin} actions`} className="flex flex-wrap items-center gap-1.5">
        {coinActions(p.coin, p.item, d).map((a) =>
          a.kind === 'link' ? (
            <Link key={a.key} to={a.to!} title={a.title} className={LINK_BTN}>
              {a.label} →
            </Link>
          ) : a.kind === 'ask' ? (
            <Button key={a.key} tier="ghost" className="min-h-[var(--tap-min)]" title={a.title} onClick={p.onAsk}>
              {a.label}
            </Button>
          ) : (
            <Button key={a.key} tier="ghost" className="min-h-[var(--tap-min)]" disabled={gate.disabled} title={gate.title} onClick={() => p.onInvestigate(p.coin)}>
              {p.busy ? 'INVESTIGATING…' : a.label}
            </Button>
          ),
        )}
      </nav>
      {/* The record block prints its own failure; without a detail the failure lands here. */}
      {p.actionError && !p.hasDetail && (
        <p role="alert" className="text-xs text-red-text">
          {p.actionError.message}
        </p>
      )}
    </div>
  )
}

function Group({ id, title, controls, children }: { id: string; title: string; controls?: ReactNode; children: ReactNode }) {
  return (
    <section aria-labelledby={`g-${id}`} data-group={id} className="flex flex-col min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 py-1.5 border-b border-border-subtle">
        <h2 id={`g-${id}`} className="label">
          {title}
        </h2>
        {controls}
      </div>
      {children}
    </section>
  )
}

function ReasonLine({ text }: { text: string }) {
  return (
    <p className="px-3 py-2 text-sm text-text-secondary break-words" data-reason>
      {text}
    </p>
  )
}

// The canvas chart library and its websocket load only in the PRICE view.
const MarketChart = lazy(() => import('../../components/charts/MarketChart').then((m) => ({ default: m.MarketChart })))

function PriceView({ coin, tf, onTf }: { coin: string; tf: Timeframe; onTf: (tf: Timeframe) => void }) {
  const stats = usePerpStats(coin)
  const name = stats.data?.coin ?? coin
  return (
    <div className="flex flex-col min-w-0" data-view="price">
      <PerpHeader coin={name} stats={stats} />
      <Suspense fallback={<SkeletonRows rows={8} />}>
        <MarketChart key={name} coin={name} tf={tf} onTfChange={onTf} />
      </Suspense>
      <div className="border-t border-border-subtle">
        <FundingPanel stats={stats} />
      </div>
    </div>
  )
}
