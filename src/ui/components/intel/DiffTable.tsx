import { useNavigate } from 'react-router'
import { classForPnl } from '../../../shared/format'
import type { DiffItem } from '../../../shared/intel'
import { DataTable, type Column } from '../DataTable'
import { ConfluenceBadge } from './ConfluenceBadge'
import { fmtDelta, fmtMetricValue, fmtSigned, fmtStopDist, METRIC_LABEL } from './format'

// DiffTable — DESIGN-terminal §3.4. Rows = brief.items in server order, not
// sortable: materiality is the only order. Row tap/Enter → /asset/:coin (§15.4).
// Only `price` Δ is green/red; every other metric prints its sign in
// text-primary (more OI or a wider spread is not "good").

const key = (i: DiffItem) => `${i.asset}:${i.metric}`

export function diffColumns(pushMateriality?: number): Column<DiffItem>[] {
  return [
    {
      key: 'asset',
      label: 'ASSET',
      priority: 1,
      render: (i) => (
        <span className="inline-flex items-baseline gap-1.5 whitespace-nowrap">
          <span className="text-md text-text-primary">{i.asset}</span>
          <span className={`text-2xs uppercase tracking-wider ${i.held ? 'text-text-primary' : 'text-text-secondary'}`}>{i.held ? 'HELD' : 'WATCH'}</span>
        </span>
      ),
    },
    { key: 'metric', label: 'METRIC', priority: 1, render: (i) => <span className="text-text-muted">{METRIC_LABEL[i.metric]}</span> },
    {
      key: 'mat',
      label: 'MAT',
      priority: 1,
      align: 'right',
      render: (i) => (
        <span className="inline-flex items-center justify-end gap-1 whitespace-nowrap">
          <span className={pushMateriality != null && i.materiality >= pushMateriality ? 'text-amber' : 'text-text-primary'}>
            {i.materiality.toFixed(2)}
          </span>
          <ConfluenceBadge factor={i.confluence} asset={i.asset} />
        </span>
      ),
    },
    {
      key: 'delta',
      label: 'Δ',
      priority: 2,
      align: 'right',
      render: (i) => <span className={i.metric === 'price' ? classForPnl(i.delta) : 'text-text-primary'}>{fmtDelta(i)}</span>,
    },
    {
      key: 'z',
      label: 'Z',
      priority: 2,
      align: 'right',
      render: (i) =>
        Number.isFinite(i.z) ? (
          <span className="text-text-primary whitespace-nowrap">z {fmtSigned(i.z, 1)}</span>
        ) : (
          <span title="fewer than 24 samples">—</span>
        ),
    },
    { key: 'now', label: 'NOW', priority: 3, align: 'right', render: (i) => fmtMetricValue(i.metric, i.to) },
    {
      key: 'stop',
      label: 'STOP',
      priority: 3,
      align: 'right',
      render: (i) => <span className="whitespace-nowrap">{fmtStopDist(i.stopDistPct, i.stopDistAtr)}</span>,
    },
    { key: 'base', label: 'BASE', priority: 4, align: 'right', render: (i) => fmtMetricValue(i.metric, i.from) },
    {
      key: 'weight',
      label: 'WEIGHT',
      priority: 4,
      align: 'right',
      render: (i) => <span title={i.held ? undefined : '0.05 floor'}>{i.exposureWeight.toFixed(2)}</span>,
    },
  ]
}

export function DiffTable({ items, pushMateriality }: { items: DiffItem[]; pushMateriality?: number }) {
  const navigate = useNavigate()
  return (
    <DataTable
      columns={diffColumns(pushMateriality)}
      rows={items}
      rowKey={key}
      onRowClick={(i) => navigate(`/asset/${encodeURIComponent(i.asset)}`)}
    />
  )
}
