import { Badge } from '../Badge'
import { DataTable, type Column } from '../DataTable'
import { fmtSigned, relTime, runStatus, signTone, type RunSummary } from '../../lib/lab'

// RunsTable — DESIGN.md §10.9, §4.4 drop order. Newest first; a row opens
// /lab/runs/:runId. Columns are limited to what RunSummary carries (no
// horizon, trial counts or duration in the summary).

export function RunsTable({ runs, onOpen }: { runs: RunSummary[]; onOpen: (r: RunSummary) => void }) {
  const columns: Column<RunSummary>[] = [
    {
      key: 'started',
      label: 'STARTED',
      priority: 1,
      render: (r) => <span title={r.createdAt}>{relTime(r.createdAt)}</span>,
    },
    {
      key: 'asset',
      label: 'ASSET·DIR',
      priority: 1,
      render: (r) => (
        <span>
          {r.asset.toUpperCase()} · <span className={r.direction === 'long' ? 'text-green' : 'text-red-text'}>{r.direction.toUpperCase()}</span>
        </span>
      ),
    },
    {
      key: 'best',
      label: 'BEST WF SHARPE',
      priority: 2,
      align: 'right',
      render: (r) => <span className={signTone(r.bestSharpe)}>{fmtSigned(r.bestSharpe)}</span>,
    },
    { key: 'rules', label: 'RULES', priority: 2, align: 'right', render: (r) => (r.status === 'error' ? '—' : r.rules) },
    {
      key: 'status',
      label: 'STATUS',
      priority: 3,
      render: (r) => {
        const s = runStatus(r)
        return (
          <Badge tone={s.tone}>
            <span title={r.error ?? undefined}>{s.label}</span>
          </Badge>
        )
      },
    },
    { key: 'metrics', label: 'METRICS', priority: 4, align: 'right', render: (r) => r.metrics },
    {
      key: 'source',
      label: 'SOURCE',
      priority: 4,
      render: (r) => <Badge tone="gray">{r.source}</Badge>,
    },
  ]
  return <DataTable columns={columns} rows={runs} rowKey={(r) => r.id} onRowClick={onOpen} />
}
