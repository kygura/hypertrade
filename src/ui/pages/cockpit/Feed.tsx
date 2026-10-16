import { useMemo } from 'react'
import { Badge, DataTable, EmptyBlock, ErrorBlock, OfflineBlock, Panel, PanelHeader, Segmented, SkeletonRows, type Column } from '../../components'
import { fmtAge } from '../../components/strategy/format'
import type { FeedRow as Row, OpportunityStatus } from '../../../shared/platform'
import { edgeWord, STATUS_WORD, type StatusFilter, type TierFilter } from './logic'
import { StaleStrip } from './Dialog'

// OpportunityFeed / FeedRow / FeedFilters — DESIGN-terminal C3. Server order
// (score desc), no click sort; the container filters client-side.

const READY_TTL_MIN = 60 // PLATFORM_READY_TTL_MIN default (SPEC P0.11)

export function StatusPill({ status }: { status: OpportunityStatus }) {
  const word = STATUS_WORD[status]
  if (status === 'ready') return <Badge tone="green">{word}</Badge>
  if (status === 'approved') return <Badge tone="green" className="!bg-transparent !border-[var(--color-green)]">{word}</Badge>
  if (status === 'investigating') return <Badge tone="info" className="pulse-label">{word}</Badge>
  if (status === 'open') return <Badge tone="info">{word}</Badge>
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

function rowColumns(now: number): Column<Row>[] {
  return [
    {
      key: 'row',
      label: 'BY SCORE',
      priority: 1,
      render: (r) => {
        const ageMin = (now - Date.parse(r.createdAt)) / 60_000
        const nearExpiry = r.status === 'ready' && ageMin >= READY_TTL_MIN - 10
        const tags = r.tags.slice(0, 3)
        const snoozed = r.snoozedUntil && Date.parse(r.snoozedUntil) > now
        return (
          <div className="flex flex-col gap-0.5 py-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span className="text-[12px] text-text-primary w-14 truncate">{r.coin}</span>
              <span className="w-10">{r.direction.toUpperCase()}</span>
              <span className="tabular text-text-primary">{r.score.toFixed(2)}</span>
              <EdgeCell row={r} />
              <StatusPill status={r.status} />
              {snoozed && <Badge tone="gray">SNOOZED {snoozeLeft(r.snoozedUntil!, now)}</Badge>}
              <span className={`ml-auto tabular text-[10px] ${nearExpiry ? 'text-amber' : 'text-text-secondary'}`} title={nearExpiry ? 'READY expires soon' : undefined}>
                {fmtAge(r.createdAt)}
              </span>
            </div>
            <div className="flex flex-wrap gap-x-2 text-[10px] text-text-secondary">
              {tags.map((t) => (
                <span key={t}>{t}</span>
              ))}
              {r.tags.length > 3 && <span>+{r.tags.length - 3}</span>}
              <span>tier T{r.liquidityTier}</span>
              {r.tradeType !== 'directional' && <span>{r.tradeType}</span>}
            </div>
          </div>
        )
      },
    },
  ]
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
  now,
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
  now: number
  snoozedOpen: boolean
  onToggleSnoozed: () => void
  onSelect: (row: Row) => void
  onFilter: (f: { status?: StatusFilter; tier?: TierFilter }) => void
  onRetry: () => void
}) {
  const columns = useMemo(() => rowColumns(now), [now])
  const count = ranked.length + snoozed.length
  const filterWord = [status !== 'all' ? status.toUpperCase() : null, tier !== 'all' ? `T${tier}` : null].filter(Boolean).join(' ') || 'ALL'
  let body
  if (loading) body = <SkeletonRows rows={8} />
  else if (offline) body = <OfflineBlock message="platform API unreachable" onRetry={onRetry} />
  else if (error) body = <ErrorBlock message={error} onRetry={onRetry} />
  else if (count === 0)
    body = <EmptyBlock label={hasRows ? `no ${filterWord} opportunities` : 'nothing cleared the bar — the scanner runs every minute'} />
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
      <PanelHeader title="FEED">
        <span className="text-[10px] tabular text-text-secondary">{count}</span>
      </PanelHeader>
      {scanAgeSec != null && scanAgeSec > 120 && <StaleStrip>scan {Math.floor(scanAgeSec / 60)}m old — scores are frozen</StaleStrip>}
      <div className="px-2 py-2 border-b border-border-subtle">
        <FeedFilters status={status} tier={tier} onFilter={onFilter} />
      </div>
      {body}
    </Panel>
  )
}
