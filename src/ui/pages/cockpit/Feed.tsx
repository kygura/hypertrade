import { useMemo, type ReactNode } from 'react'
import { Badge, DataTable, ErrorBlock, HowToRead, OfflineBlock, Panel, PanelHeader, Segmented, SkeletonRows, StaleStrip, type Column, type Term } from '../../components'
import { fmtAge } from '../../components/strategy/format'
import { isExtremesOpportunity } from '../../../shared/extremes'
import type { FeedRow as Row, OpportunityStatus } from '../../../shared/platform'
import { edgeWord, STATUS_WORD, type StatusFilter, type TierFilter } from './logic'

// OpportunityFeed / FeedRow / FeedFilters — DESIGN-terminal C3. Server order
// (score desc), no click sort; the container filters client-side.

const TERMS: readonly Term[] = [
  ['Row, left to right', 'Coin, direction, score, edge, status, and the time since the idea was raised. The second line holds up to three tags from the setup, the liquidity tier, and the trade type when it is not a plain directional trade.'],
  ['Score', 'How unusual the move is, not how profitable. It is the largest z-score among five features (15-minute return, price acceleration, 1-hour open interest change, funding against its last 24 hours, 1-hour volume ratio), multiplied by 1.25 when two kinds of signal fire together and 1.5 when three do. The feed is sorted by it. SEV marks an extremes take instead: the detector\'s severity in its own sigmas, a different number that sorts in the same column.'],
  ['Edge (bp)', 'Estimated profit after costs, in basis points (100bp = 1%): gross edge minus fees on entry and exit, slippage and funding. A dash means no cost model exists for that trade type. Score and edge are separate numbers and are never combined.'],
  ['COSTS EXCEED EDGE', 'The estimated costs are larger than the gross edge, so the net is negative.'],
  ['UNVALIDATED', 'The gross edge is only the distance from stop to target, because this setup has fewer than 30 resolved outcomes on record.'],
  ['Status', 'NEW: just raised. INVESTIGATING: research is running. CALC: costs are attached. READY: can be approved. APPROVED, OPEN, CLOSED: the order was sent, is in the market, is finished. REJECTED: you declined it. EXPIRED: it stayed READY past its time limit. FAILED: the order could not be placed after approval.'],
  ['tier T1 · T2 · T3', 'Liquidity tier by 24-hour volume: T1 is the most traded third of all perps, T3 the least.'],
  ['Age', 'Time since the idea was raised. Amber when a READY idea is within 10 minutes of expiring.'],
  ['LIVE · READY · DECIDED', 'Filters. LIVE is everything not yet decided; DECIDED is approved, open or finished.'],
  ['SNOOZED', 'Ideas you hid for a set time. They stay below the list until the timer runs out.'],
]

export function StatusPill({ status }: { status: OpportunityStatus }) {
  const word = STATUS_WORD[status]
  if (status === 'ready') return <Badge tone="green">{word}</Badge>
  if (status === 'approved') return <Badge tone="green" className="!bg-transparent !border-[var(--color-green)]">{word}</Badge>
  if (status === 'investigating') return <Badge tone="info" className="pulse-label">{word}</Badge>
  if (status === 'open') return <Badge tone="info">{word}</Badge>
  // Placement failed after approval (system-only): critical, not the gray of an operator reject.
  if (status === 'failed') return <Badge tone="red">{word}</Badge>
  return <Badge tone="gray">{word}</Badge>
}

export function EdgeCell({ row }: { row: Pick<Row, 'netEdgeBps' | 'edgeBasis' | 'tradeType'> }) {
  const e = edgeWord(row)
  return (
    <span className="inline-flex items-center gap-1 tabular" title={e.title}>
      <span className={e.tone === 'green' ? 'text-green' : 'text-text-primary'}>{e.text}</span>
      {e.costsExceed && <Badge tone="red">COSTS EXCEED EDGE</Badge>}
      {e.unvalidated && (
        <span title="gross edge is the setup's stop-to-target distance; fewer than 30 resolved outcomes for this setup">
          <Badge tone="info">UNVALIDATED</Badge>
        </span>
      )}
    </span>
  )
}

function snoozeLeft(until: string, now: number): string {
  const m = Math.max(0, Math.ceil((Date.parse(until) - now) / 60_000))
  return m < 60 ? `${m}M` : `${Math.floor(m / 60)}H${m % 60 ? ` ${m % 60}M` : ''}`
}

/** An extremes take shows its severity, labelled: a different number from the scanner score, never read as one. */
export function scoreCell(r: Pick<Row, 'score' | 'scoreVersion' | 'setupKind'>): { text: string; title: string } {
  return isExtremesOpportunity(r)
    ? { text: `sev ${r.score.toFixed(2)}`, title: `severity: the extremes detector's sigmas (${r.scoreVersion}), not the scanner score` }
    : { text: r.score.toFixed(2), title: 'score: how unusual the move is (largest z-score, raised when signals coincide)' }
}

function rowColumns(now: number, readyTtlMin: number, extremesReadyTtlMin: number): Column<Row>[] {
  return [
    {
      key: 'row',
      label: <span className="sr-only">opportunity</span>,
      priority: 1,
      render: (r) => {
        // A ready row expires readyTtlMin (an extremes take: extremesReadyTtlMin) after it became ready (statusChangedAt).
        const readyMin = r.statusChangedAt ? (now - Date.parse(r.statusChangedAt)) / 60_000 : null
        const ttl = isExtremesOpportunity(r) ? extremesReadyTtlMin : readyTtlMin
        const nearExpiry = r.status === 'ready' && readyMin != null && readyMin >= ttl - 10
        const score = scoreCell(r)
        const tags = r.tags.slice(0, 3)
        const snoozed = r.snoozedUntil && Date.parse(r.snoozedUntil) > now
        return (
          <div className="flex flex-col gap-0.5 py-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span className="text-md text-text-primary w-14 truncate">{r.coin}</span>
              <span className="w-10">{r.direction.toUpperCase()}</span>
              <span className="tabular text-text-primary" title={score.title}>{score.text}</span>
              <EdgeCell row={r} />
              <StatusPill status={r.status} />
              {snoozed && <Badge tone="gray">SNOOZED {snoozeLeft(r.snoozedUntil!, now)}</Badge>}
              <span className={`ml-auto tabular text-xs ${nearExpiry ? 'text-amber' : 'text-text-secondary'}`} title={nearExpiry ? 'READY expires within 10 minutes' : 'time since the idea was raised'}>
                {fmtAge(r.createdAt)}
              </span>
            </div>
            <div className="flex flex-wrap gap-x-2 text-xs text-text-secondary">
              {tags.map((t) => (
                <span key={t}>{t}</span>
              ))}
              {r.tags.length > 3 && <span>+{r.tags.length - 3}</span>}
              <span title="liquidity tier by 24h volume: T1 most traded third of perps, T3 least">tier T{r.liquidityTier}</span>
              {r.tradeType !== 'directional' && <span>{r.tradeType}</span>}
            </div>
          </div>
        )
      },
    },
  ]
}

/** Minutes of scanner history the z-scores need before ideas can clear the bar. */
const WARM_MIN = 60

/** SPEC P3 gate amendment: shown while the scanner ring is short and nothing has been found yet. */
export function WarmingLine({ scanHistoryMin, hasRows }: { scanHistoryMin: number | null | undefined; hasRows: boolean }) {
  if (scanHistoryMin == null || scanHistoryMin >= WARM_MIN || hasRows) return null
  return (
    <p className="px-3 py-1.5 text-xs tabular text-amber" role="status">
      SCANNER WARMING UP — {Math.floor(scanHistoryMin)} of {WARM_MIN} MIN HISTORY. The z-scores need an hour of stored scans before any idea can
      clear the bar.
    </p>
  )
}

const STATUS_OPTS = [
  { value: 'live', label: 'LIVE' },
  { value: 'ready', label: 'READY' },
  { value: 'decided', label: 'DECIDED' },
  { value: 'all', label: 'ALL' },
] as const
const TIER_OPTS = [
  { value: 'all', label: 'ALL' },
  { value: 1, label: 'T1' },
  { value: 2, label: 'T2' },
  { value: 3, label: 'T3' },
] as const

export function FeedFilters({ status, tier, onFilter }: { status: StatusFilter; tier: TierFilter; onFilter: (f: { status?: StatusFilter; tier?: TierFilter }) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Segmented label="status filter" size="sm" options={STATUS_OPTS} value={status} onChange={(v) => onFilter({ status: v })} />
      <Segmented<TierFilter> label="tier filter" size="sm" options={TIER_OPTS} value={tier} onChange={(v) => onFilter({ tier: v })} />
    </div>
  )
}

export function OpportunityFeed({
  ranked,
  snoozed,
  selectedId,
  status,
  tier,
  loading,
  offline,
  error,
  scanAgeSec,
  hasRows,
  insight,
  now,
  readyTtlMin,
  extremesReadyTtlMin = 240,
  emptySlot,
  snoozedOpen,
  onToggleSnoozed,
  onSelect,
  onFilter,
  onRetry,
}: {
  ranked: Row[]
  snoozed: Row[]
  selectedId: string | null
  status: StatusFilter
  tier: TierFilter
  loading: boolean
  offline: string | null
  error: string | null
  scanAgeSec: number | null
  /** Any row at all before filtering (decides which empty copy). */
  hasRows: boolean
  /** feedInsight over the unfiltered rows; null hides the line. */
  insight?: string | null
  now: number
  /** PLATFORM_READY_TTL_MIN from the feed response. */
  readyTtlMin: number
  /** EXTREMES_READY_TTL_H in minutes from the feed response (the TTL of an extremes take). */
  extremesReadyTtlMin?: number
  /** Rendered under the empty line when no row matches (the liquidation board, C2 gate amendment). */
  emptySlot?: ReactNode
  snoozedOpen: boolean
  onToggleSnoozed: () => void
  onSelect: (row: Row) => void
  onFilter: (f: { status?: StatusFilter; tier?: TierFilter }) => void
  onRetry: () => void
}) {
  const columns = useMemo(() => rowColumns(now, readyTtlMin, extremesReadyTtlMin), [now, readyTtlMin, extremesReadyTtlMin])
  const count = ranked.length + snoozed.length
  const filterWord = [status !== 'all' ? status.toUpperCase() : null, tier !== 'all' ? `T${tier}` : null].filter(Boolean).join(' ') || 'ALL'
  let body
  if (loading) body = <SkeletonRows rows={8} />
  else if (offline) body = <OfflineBlock message="platform API unreachable" onRetry={onRetry} />
  else if (error) body = <ErrorBlock message={error} onRetry={onRetry} />
  else if (count === 0)
    body = (
      <>
        <p className="px-3 py-2 text-sm text-text-secondary">
          {hasRows
            ? `no ${filterWord} opportunities. Other filters still have rows.`
            : 'No ideas right now. The scanner checks the market every minute and lists an idea here when a setup fires; nothing has cleared the bar.'}
        </p>
        {emptySlot}
      </>
    )
  else
    body = (
      <div data-feed>
        {ranked.length > 0 && <DataTable columns={columns} rows={ranked} rowKey={(r) => r.id} onRowClick={onSelect} isSelected={(r) => r.id === selectedId} />}
        {snoozed.length > 0 && (
          <div className="border-t border-border-subtle">
            <button type="button" className="label w-full text-left px-2 py-2 min-h-[var(--tap-min)] hover:text-text-primary" aria-expanded={snoozedOpen} onClick={onToggleSnoozed}>
              SNOOZED · {snoozed.length} {snoozedOpen ? '▾' : '▸'}
            </button>
            {snoozedOpen && <DataTable columns={columns} rows={snoozed} rowKey={(r) => r.id} onRowClick={onSelect} isSelected={(r) => r.id === selectedId} />}
          </div>
        )}
      </div>
    )
  return (
    <Panel className="min-w-0">
      <PanelHeader title="FEED ─ BY SCORE">
        <span className="text-xs tabular text-text-secondary">{count}</span>
      </PanelHeader>
      {scanAgeSec != null && scanAgeSec > 120 && <StaleStrip>scan {Math.floor(scanAgeSec / 60)}m old — scores are frozen</StaleStrip>}
      <div className="flex flex-col gap-1 px-2 py-2 border-b border-border-subtle">
        {insight && <p className="text-md text-text-primary">{insight}</p>}
        <HowToRead terms={TERMS}>
          Trade ideas the scanner raised, highest score first. Score says how unusual the move is; edge says what is left after costs.
          Select a row to see why it fired and what it would cost.
        </HowToRead>
      </div>
      <div className="px-2 py-2 border-b border-border-subtle">
        <FeedFilters status={status} tier={tier} onFilter={onFilter} />
      </div>
      {body}
    </Panel>
  )
}
