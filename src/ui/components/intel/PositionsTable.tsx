import { useNavigate } from 'react-router'
import { classForPnl, fmtPrice, fmtUsd } from '../../../shared/format'
import type { ExposurePosition } from '../../../shared/intel'
import { Badge } from '../Badge'
import { Button } from '../Button'
import { DataTable, type Column } from '../DataTable'
import { SrcTag } from '../SrcTag'
import { fmtStopDist, MINUS } from './format'

// PositionsTable — DESIGN-terminal §3.7. Rows = positions[] across all three
// sources, default sort notional desc. Row tap/Enter → /markets/:coin. Only
// manual rows carry EDIT (HL/DESK rows are read-only). No stop → amber
// NO STOP: stop proximity drives materiality, so it outranks PnL.

/** Distance from mark to stop in percent (absolute), or null without a stop. */
export function stopDistPct(p: Pick<ExposurePosition, 'markPx' | 'stopPx'>): number | null {
  if (p.stopPx == null || !(p.markPx > 0)) return null
  return (Math.abs(p.markPx - p.stopPx) / p.markPx) * 100
}

function fmtSignedUsd(n: number): string {
  return `${n > 0 ? '+' : n < 0 ? MINUS : ''}${fmtUsd(Math.abs(n), { compact: Math.abs(n) >= 10_000 })}`
}

export function positionColumns(onEdit: (p: ExposurePosition) => void): Column<ExposurePosition>[] {
  return [
    {
      key: 'asset',
      label: 'ASSET',
      priority: 1,
      sortValue: (p) => p.asset,
      render: (p) => (
        <span className="flex flex-col gap-0.5 py-1">
          <span className="inline-flex items-center gap-1.5">
            <span className="text-[12px] text-text-primary">{p.asset}</span>
            <SrcTag source={p.source} />
          </span>
          <span className={`text-[9px] uppercase tracking-wider ${p.side === 'long' ? 'text-green' : 'text-red-text'}`}>
            {p.side === 'long' ? 'LONG' : 'SHORT'} {p.leverage}×
          </span>
        </span>
      ),
    },
    { key: 'notional', label: 'NOTIONAL', priority: 1, align: 'right', sortValue: (p) => p.notionalUsd, render: (p) => fmtUsd(p.notionalUsd, { compact: true }) },
    {
      key: 'actions',
      label: '',
      priority: 1,
      align: 'right',
      render: (p) =>
        p.source === 'manual' ? (
          <Button
            tier="ghost"
            aria-label={`edit ${p.asset} position`}
            onClick={(e) => {
              e.stopPropagation()
              onEdit(p)
            }}
            onKeyDown={(e) => e.stopPropagation()}
          >
            EDIT
          </Button>
        ) : null,
    },
    {
      key: 'stopDist',
      label: 'STOP DIST',
      priority: 2,
      align: 'right',
      sortValue: (p) => stopDistPct(p) ?? Infinity,
      render: (p) => {
        const d = stopDistPct(p)
        return d == null ? <Badge tone="amber">NO STOP</Badge> : <span title={`stop ${fmtPrice(p.stopPx!)}`}>{fmtStopDist(d)}</span>
      },
    },
    {
      key: 'upnl',
      label: 'UPNL',
      priority: 3,
      align: 'right',
      sortValue: (p) => p.unrealizedPnl ?? 0,
      render: (p) => (p.unrealizedPnl == null ? '—' : <span className={classForPnl(p.unrealizedPnl)}>{fmtSignedUsd(p.unrealizedPnl)}</span>),
    },
    { key: 'size', label: 'SIZE', priority: 3, align: 'right', render: (p) => p.size.toLocaleString(undefined, { maximumFractionDigits: 6 }) },
    { key: 'entry', label: 'ENTRY', priority: 3, align: 'right', render: (p) => fmtPrice(p.entryPx) },
    { key: 'mark', label: 'MARK', priority: 3, align: 'right', render: (p) => fmtPrice(p.markPx) },
    { key: 'stop', label: 'STOP', priority: 4, align: 'right', render: (p) => (p.stopPx == null ? '—' : fmtPrice(p.stopPx)) },
    { key: 'venue', label: 'VENUE', priority: 4, render: (p) => <span className="text-[10px] text-text-muted">{p.venue}</span> },
  ]
}

export function PositionsTable({ positions, onEdit }: { positions: ExposurePosition[]; onEdit: (p: ExposurePosition) => void }) {
  const navigate = useNavigate()
  return (
    <DataTable
      columns={positionColumns(onEdit)}
      rows={positions}
      rowKey={(p) => p.id}
      sortable
      defaultSort={{ key: 'notional', dir: 'desc' }}
      onRowClick={(p) => navigate(`/markets/${encodeURIComponent(p.asset)}`)}
    />
  )
}
