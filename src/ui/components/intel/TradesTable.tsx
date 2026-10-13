import type { Trade } from '../../../shared/intel'
import { classForPnl } from '../../../shared/format'
import { DataTable, type Column } from '../DataTable'
import { EmptyBlock } from '../state'
import { SrcTag } from '../SrcTag'
import { fmtTs } from '../strategy/format'
import { fmtHold, fmtMdHm, fmtR, fmtSignedNum, fmtUsdSigned2, signClass } from './format'

// TradesTable — DESIGN-terminal §4.2. Newest close first (open round trips on
// top), `isSelected` = the `?trade` row; row tap/Enter selects. Each row
// carries an `id="trade-<id>"` anchor (in its first cell) so report links can
// scroll to it. Priority columns per §4.2; tapping a row opens TradeDetail,
// which shows everything a narrow screen drops.

export const UNTAGGED_TAG = 'untagged'

export function tradeAnchorId(id: string): string {
  return `trade-${id}`
}

export function matchesTag(t: Trade, tag: string | null): boolean {
  if (!tag) return true
  return tag === UNTAGGED_TAG ? t.tag == null : t.tag === tag
}

export function sortTrades(trades: Trade[]): Trade[] {
  const key = (t: Trade) => (t.closedAt ? Date.parse(t.closedAt) : Number.POSITIVE_INFINITY)
  return [...trades].sort((a, b) => key(b) - key(a))
}

export function fmtExcursion(t: Pick<Trade, 'mae' | 'mfe' | 'maeUnit'>): string {
  if (t.mae == null && t.mfe == null) return '—'
  const unit = t.maeUnit === 'r' ? 'R' : '%'
  const mae = t.mae == null ? '—' : fmtSignedNum(-Math.abs(t.mae), 1)
  const mfe = t.mfe == null ? '—' : fmtSignedNum(Math.abs(t.mfe), 1)
  return `${mae} / ${mfe}${unit}`
}

export function SideWord({ side }: { side: Trade['side'] }) {
  return <span className={side === 'long' ? 'text-green' : 'text-red-text'}>{side === 'long' ? 'LONG' : 'SHORT'}</span>
}

export function RCell({ r }: { r: number | null }) {
  if (r == null)
    return (
      <span className="text-text-secondary" title="no stop known">
        —
      </span>
    )
  return <span className={signClass(r)}>{fmtR(r)}</span>
}

function TagChips({ tag }: { tag: string | null }) {
  if (!tag) return <span className="text-text-secondary">—</span>
  return <span className="src-tag">{tag}</span>
}

const COLUMNS: Column<Trade>[] = [
  {
    key: 'coin',
    label: 'COIN',
    priority: 1,
    render: (t) => (
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
        <span id={tradeAnchorId(t.id)} className="scroll-mt-[140px]" />
        <span className="text-text-primary">{t.asset}</span>
        <SrcTag source={t.venue} />
      </span>
    ),
  },
  { key: 'side', label: 'SIDE', priority: 1, render: (t) => <SideWord side={t.side} /> },
  { key: 'r', label: 'R', priority: 1, align: 'right', render: (t) => <RCell r={t.r} /> },
  {
    key: 'closed',
    label: 'CLOSED',
    priority: 2,
    render: (t) =>
      t.closedAt ? (
        <span title={fmtTs(t.closedAt)} className="whitespace-nowrap">
          {fmtMdHm(t.closedAt)}
        </span>
      ) : (
        <span className="text-amber">OPEN</span>
      ),
  },
  { key: 'hold', label: 'HOLD', priority: 2, align: 'right', render: (t) => <span className="whitespace-nowrap">{fmtHold(t.holdMs)}</span> },
  { key: 'mae', label: 'MAE/MFE', priority: 3, align: 'right', render: (t) => <span className="whitespace-nowrap">{fmtExcursion(t)}</span> },
  { key: 'tags', label: 'TAGS', priority: 3, render: (t) => <TagChips tag={t.tag} /> },
  { key: 'pnl', label: 'PNL', priority: 4, align: 'right', render: (t) => <span className={classForPnl(t.pnlUsd)}>{fmtUsdSigned2(t.pnlUsd)}</span> },
  {
    key: 'opened',
    label: 'OPENED',
    priority: 4,
    render: (t) => (
      <span title={fmtTs(t.openedAt)} className="whitespace-nowrap">
        {fmtMdHm(t.openedAt)}
      </span>
    ),
  },
  { key: 'session', label: 'SESSION', priority: 4, render: (t) => t.session.toUpperCase() },
  {
    key: 'note',
    label: 'NOTE',
    priority: 4,
    render: (t) =>
      t.note ? (
        <span className="block max-w-[40ch] truncate text-text-muted" title={t.note}>
          {t.note}
        </span>
      ) : (
        <span className="text-text-secondary">—</span>
      ),
  },
]

export function TradesTable({
  trades,
  selectedId,
  tagFilter,
  onSelect,
}: {
  trades: Trade[]
  selectedId: string | null
  tagFilter: string | null
  onSelect: (id: string) => void
}) {
  const rows = sortTrades(trades.filter((t) => matchesTag(t, tagFilter)))
  return (
    <DataTable
      columns={COLUMNS}
      rows={rows}
      rowKey={(t) => t.id}
      onRowClick={(t) => onSelect(t.id)}
      isSelected={(t) => t.id === selectedId}
      emptyLabel={<EmptyBlock label={tagFilter ? `no trades tagged ${tagFilter} in this window` : 'no trades in this window'} />}
    />
  )
}
