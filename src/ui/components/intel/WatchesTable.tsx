import type { Watch } from '../../../shared/intel'
import { Badge, StatusDot } from '../Badge'
import { DataTable, type Column } from '../DataTable'
import { ClaimAge } from './ClaimAge'
import { checkedAgeHours, KIND_LABEL, shortTarget } from './watch'

// WatchesTable — DESIGN-terminal §8.2. DataTable, `isSelected` = `?id`.
// P1 TARGET + STATE; P2 KIND, CHECKED (amber > 2 h, STALE Badge > 6 h); P3
// ASSET; P4 CHAIN. A row with an error shows it as a red 10px second line at
// lg. Enter / click selects.

function StateCell({ w }: { w: Watch }) {
  if (w.error) {
    return (
      <span className="text-red-text" title={w.error}>
        ✕<span className="sr-only"> error: {w.error}</span>
      </span>
    )
  }
  if (!w.checkedAt) {
    return (
      <span className="inline-flex items-center gap-1 text-text-secondary">
        <StatusDot status="unknown" />
        <span className="sr-only">not checked yet</span>
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1">
      <StatusDot status="ok" />
      <span className="sr-only">ok</span>
    </span>
  )
}

export function WatchesTable({ watches, selectedId, onSelect }: { watches: Watch[]; selectedId: string | null; onSelect: (id: string) => void }) {
  const columns: Column<Watch>[] = [
    {
      key: 'kind',
      label: 'KIND',
      priority: 2,
      render: (w) => <span className="text-text-secondary">{KIND_LABEL[w.kind]}</span>,
    },
    {
      key: 'target',
      label: 'TARGET',
      priority: 1,
      render: (w) => (
        <div className="flex flex-col min-w-0 py-1">
          <span className="text-text-primary truncate max-w-[22ch] md:max-w-[32ch]" title={w.target}>
            {w.label || shortTarget(w.kind, w.target)}
          </span>
          {w.error && <span className="hidden lg:block text-xs text-red-text break-words">{w.error}</span>}
        </div>
      ),
    },
    { key: 'asset', label: 'ASSET', priority: 3, render: (w) => w.asset ?? '—' },
    {
      key: 'checked',
      label: 'CHECKED',
      priority: 2,
      render: (w) => {
        const h = checkedAgeHours(w)
        if (h == null || !w.checkedAt) return <span className="text-text-secondary">—</span>
        return (
          <span className="inline-flex items-center gap-1">
            <ClaimAge ts={w.checkedAt} thresholdHours={2} />
            {h > 6 && <Badge tone="amber">STALE</Badge>}
          </span>
        )
      },
    },
    { key: 'state', label: 'STATE', priority: 1, render: (w) => <StateCell w={w} /> },
    { key: 'chain', label: 'CHAIN', priority: 4, render: (w) => <span className="text-text-secondary">{w.chain ?? '—'}</span> },
  ]
  return <DataTable columns={columns} rows={watches} rowKey={(w) => w.id} onRowClick={(w) => onSelect(w.id)} isSelected={(w) => w.id === selectedId} />
}
