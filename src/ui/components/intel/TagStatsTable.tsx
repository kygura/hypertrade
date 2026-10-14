import type { TagStats } from '../../../shared/intel'
import { Badge } from '../Badge'
import { DataTable, type Column } from '../DataTable'
import { fmtHold, fmtR, fmtSigned, fmtUsdSigned, signClass } from './format'

// TagStatsTable — DESIGN-terminal §4.2. Rows in server order (expectancy
// desc — the header says so); N < 5 gets an amber `FEW` badge. Row tap sets
// `?tag=` and scrolls to TRADES. EXP is signed R when stops are known, else
// signed USD per trade.

export const FEW_TRADES = 5

function Exp({ s }: { s: TagStats }) {
  if (s.expectancyR != null) return <span className={signClass(s.expectancyR)}>{fmtR(s.expectancyR, 2)}</span>
  return (
    <span className={signClass(s.expectancyUsd)} title="no stops known — USD per trade">
      {fmtUsdSigned(s.expectancyUsd)}
    </span>
  )
}

const COLUMNS: Column<TagStats>[] = [
  {
    key: 'tag',
    label: 'TAG',
    priority: 1,
    render: (s) => (
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
        <span className="text-text-primary">{s.tag}</span>
        {s.trades < FEW_TRADES && (
          <span title="fewer than 5 trades — not evidence">
            <Badge tone="amber">FEW</Badge>
          </span>
        )}
      </span>
    ),
  },
  { key: 'n', label: 'N', priority: 1, align: 'right', render: (s) => s.trades },
  { key: 'exp', label: 'EXP', priority: 1, align: 'right', render: (s) => <Exp s={s} /> },
  { key: 'win', label: 'WIN', priority: 2, align: 'right', render: (s) => `${Math.round(s.winRate * 100)}%` },
  { key: 'avgr', label: 'AVG R', priority: 2, align: 'right', render: (s) => <span className={signClass(s.avgR)}>{fmtR(s.avgR)}</span> },
  { key: 'hold', label: 'HOLD', priority: 3, align: 'right', render: (s) => fmtHold(s.avgHoldMs) },
  { key: 'mae', label: 'MAE', priority: 4, align: 'right', render: (s) => (s.avgMaePct == null ? '—' : fmtSigned(-Math.abs(s.avgMaePct), 1, '%')) },
  { key: 'mfe', label: 'MFE', priority: 4, align: 'right', render: (s) => (s.avgMfePct == null ? '—' : fmtSigned(Math.abs(s.avgMfePct), 1, '%')) },
]

export function TagStatsTable({ stats, onTag, selectedTag }: { stats: TagStats[]; onTag: (tag: string) => void; selectedTag?: string | null }) {
  return (
    <DataTable
      columns={COLUMNS}
      rows={stats}
      rowKey={(s) => s.tag}
      onRowClick={(s) => onTag(s.tag)}
      isSelected={selectedTag ? (s) => s.tag === selectedTag : undefined}
    />
  )
}
