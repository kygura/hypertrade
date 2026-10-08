import { Badge } from '../Badge'
import { Button } from '../Button'
import { DataTable, type Column } from '../DataTable'
import { FiringBadge } from '../FiringBadge'
import { RuleText } from '../RuleText'
import { fmtSigned, signTone, type CatalogueHealth, type CatalogueListEntry, type MetricDef } from '../../lib/lab'
import { DirectionWord } from './common'

// CatalogueTable — DESIGN.md §10.9, §4.4 drop order. Ranked by LIVE SHARPE
// (the "is it still working" column); HOLDOUT and WF are the numbers at
// save time, printed as a pair. Per-row REMOVE at lg only.

const liveOk = (e: CatalogueListEntry) => e.live != null && e.live.days >= 30

export function CatalogueTable({
  entries,
  metrics,
  firing,
  health,
  onOpen,
  onRemove,
}: {
  entries: CatalogueListEntry[]
  metrics: readonly MetricDef[]
  firing: Map<string, boolean> | null
  health: CatalogueHealth | null
  onOpen: (e: CatalogueListEntry) => void
  onRemove: (e: CatalogueListEntry) => void
}) {
  const nameOf = (id: string) => entries.find((e) => e.id === id)?.name ?? id.slice(0, 8)
  const partners = (id: string) =>
    (health?.overlaps ?? [])
      .filter((o) => o.a === id || o.b === id)
      .map((o) => `${nameOf(o.a === id ? o.b : o.a)} (J ${o.jaccard.toFixed(2)})`)
      .join(', ')

  const columns: Column<CatalogueListEntry>[] = [
    {
      key: 'name',
      label: 'NAME',
      priority: 1,
      sortValue: (e) => e.name.toLowerCase(),
      render: (e) => (
        <div className="flex flex-col py-1 min-w-0 max-w-[48ch]">
          <span className="text-sm text-text-primary truncate">{e.name}</span>
          <RuleText rule={e.rule} metrics={metrics} size="xs" className="text-text-secondary truncate" />
        </div>
      ),
    },
    {
      key: 'live',
      label: 'LIVE SHARPE',
      priority: 1,
      align: 'right',
      sortValue: (e) => (liveOk(e) ? e.live!.sharpe : -Infinity),
      render: (e) =>
        liveOk(e) ? (
          <span className={signTone(e.live!.sharpe)}>{fmtSigned(e.live!.sharpe)}</span>
        ) : (
          <span className="text-text-secondary" title={`${e.live?.days ?? 0} live days`}>
            —
          </span>
        ),
    },
    {
      key: 'firing',
      label: 'FIRING',
      priority: 2,
      render: (e) => {
        const f = firing?.get(e.id)
        return f == null ? <span className="text-text-secondary">—</span> : <FiringBadge firing={f} />
      },
    },
    {
      key: 'health',
      label: 'HEALTH',
      priority: 2,
      render: (e) =>
        e.flags.length === 0 ? (
          <span className="text-text-secondary">—</span>
        ) : (
          <span className="inline-flex gap-1">
            {e.flags.includes('decayed') && <Badge tone="amber">DECAYED</Badge>}
            {e.flags.includes('overlap') && (
              <Badge tone="gray">
                <span title={partners(e.id) || 'overlaps another rule'}>OVERLAP</span>
              </Badge>
            )}
          </span>
        ),
    },
    {
      key: 'holdout',
      label: 'HOLDOUT',
      priority: 3,
      align: 'right',
      // Rule 2: holdout never sorts anything — no sortValue, so no sort control.
      render: (e) => <span className={signTone(e.saved.holdout?.sharpe)}>{fmtSigned(e.saved.holdout?.sharpe)}</span>,
    },
    {
      key: 'wf',
      label: 'WF',
      priority: 3,
      align: 'right',
      sortValue: (e) => e.saved.walkForward?.sharpe ?? -Infinity,
      render: (e) => <span className={signTone(e.saved.walkForward?.sharpe)}>{fmtSigned(e.saved.walkForward?.sharpe)}</span>,
    },
    {
      key: 'dirhzn',
      label: 'DIR·HZN',
      priority: 3,
      render: (e) => (
        <span>
          <DirectionWord direction={e.rule.direction} /> {e.rule.asset.toUpperCase()} {e.rule.horizonDays}D
        </span>
      ),
    },
    {
      key: 'days',
      label: 'LIVE DAYS',
      priority: 4,
      align: 'right',
      sortValue: (e) => e.live?.days ?? 0,
      render: (e) => e.live?.days ?? 0,
    },
    {
      key: 'saved',
      label: 'SAVED',
      priority: 4,
      sortValue: (e) => e.savedAt,
      render: (e) => <span title={e.savedAt}>{e.savedAt.slice(0, 10)}</span>,
    },
    { key: 'origin', label: 'ORIGIN', priority: 4, render: (e) => <Badge tone="gray">{e.origin}</Badge> },
    {
      key: 'remove',
      label: <span className="sr-only">actions</span>,
      priority: 4,
      align: 'right',
      render: (e) => (
        <Button
          tier="danger"
          onClick={(ev) => {
            ev.stopPropagation()
            onRemove(e)
          }}
          onKeyDown={(ev) => ev.stopPropagation()}
          aria-label={`remove ${e.name}`}
        >
          REMOVE
        </Button>
      ),
    },
  ]

  return (
    <DataTable
      columns={columns}
      rows={entries}
      rowKey={(e) => e.id}
      onRowClick={onOpen}
      sortable
      defaultSort={{ key: 'live', dir: 'desc' }}
    />
  )
}
