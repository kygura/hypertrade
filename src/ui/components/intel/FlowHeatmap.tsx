import { useState, type KeyboardEvent } from 'react'
import { useNavigate } from 'react-router'
import type { FlowFlag, HeatmapMetric, HeatmapResponse, HeatmapWindow } from '../../../shared/intel'
import { Badge } from '../Badge'
import { fmtSigned } from './format'
import { BUCKET_BG, cellTitle, chipText, firingChips, flagWord, flowSourceText, HEAT_COLUMNS, zBucket } from './flow'

// FlowHeatmap — DESIGN-terminal §15.2. Rows in server order (materiality),
// not sortable. Twelve columns in the pinned order, SNAPSHOT 8 + FLOW 4,
// never priority-hidden; sticky ASSET column and header inside .table-scroll.
// Cell = signed z on the momentum ramp bucketed at |z| 1 and 2; null empty.
// One tab stop per row: ←/→ move a visible cell focus, Enter opens the asset
// page (with ?metric when a cell is focused).

type Cell = HeatmapResponse['cells'][number]

const assetHref = (coin: string, metric?: HeatmapMetric) => `/asset/${encodeURIComponent(coin)}${metric ? `?metric=${metric}` : ''}`

export function HeatCell({
  asset,
  metric,
  window,
  cell,
  nullTitle,
  focused,
  divider,
  onOpen,
}: {
  asset: string
  metric: HeatmapMetric
  window: HeatmapWindow
  cell: Cell | undefined
  /** Overrides the null `title` (the FLOW group with no source). */
  nullTitle?: string
  focused: boolean
  divider: boolean
  onOpen: () => void
}) {
  const z = nullTitle ? null : (cell?.z ?? null)
  const b = zBucket(z)
  const title = nullTitle ?? cellTitle(asset, metric, window, z, cell?.delta ?? null)
  return (
    <td
      id={`heat-${asset}-${metric}`}
      title={title}
      aria-label={title}
      onClick={(e) => {
        e.stopPropagation()
        onOpen()
      }}
      style={{ background: BUCKET_BG[b], height: 'var(--tap-min)' }}
      className={`min-w-[44px] px-1 text-center text-sm tabular cursor-pointer ${b === 'zero' ? 'text-text-secondary' : 'text-text-primary'} ${
        divider ? 'border-l border-border' : ''
      } ${focused ? 'outline outline-1 outline-text-primary -outline-offset-1' : ''}`}
    >
      {z == null ? '' : fmtSigned(z, 1)}
    </td>
  )
}

function FlagsCell({ flags }: { flags: FlowFlag[] }) {
  if (flags.length === 0) return <td className="px-2" />
  const all = flags.map((f) => flagWord(f).toLowerCase()).join(', ')
  return (
    <td className="px-2 whitespace-nowrap" title={all}>
      <span className="inline-flex items-center gap-1">
        {flags.slice(0, 2).map((f) => (
          <Badge key={f.id} tone="gray">
            {flagWord(f).toLowerCase()}
          </Badge>
        ))}
        {flags.length > 2 && <span className="text-xs text-text-secondary">+{flags.length - 2}</span>}
      </span>
    </td>
  )
}

export function FlowHeatmap({ data, window }: { data: HeatmapResponse; window: HeatmapWindow }) {
  const navigate = useNavigate()
  const [focus, setFocus] = useState<{ asset: string; col: number } | null>(null)
  const cells = new Map(data.cells.map((c) => [`${c.asset}:${c.metric}`, c]))
  const materiality = new Map(data.rows.map((r) => [r.asset, r.materiality]))
  const firing = firingChips(data.flags, materiality)
  const noSource = data.flow.ok ? undefined : flowSourceText(data.flow)
  const flowStart = HEAT_COLUMNS.findIndex((c) => c.group === 'flow')

  const onKey = (asset: string) => (e: KeyboardEvent<HTMLTableRowElement>) => {
    const col = focus?.asset === asset ? focus.col : -1
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault()
      const next = e.key === 'ArrowRight' ? Math.min(col + 1, HEAT_COLUMNS.length - 1) : Math.max(col - 1, -1)
      setFocus(next < 0 ? null : { asset, col: next })
    } else if (e.key === 'Enter') {
      navigate(assetHref(asset, col >= 0 ? HEAT_COLUMNS[col]!.metric : undefined))
    }
  }

  return (
    <div className="table-scroll max-h-[70vh]">
      <table className="w-full text-sm tabular border-separate [border-spacing:1px] bg-body">
        <thead className="sticky top-0 z-[2] bg-panel">
          <tr>
            <th className="sticky left-0 z-[3] bg-panel" />
            <th colSpan={flowStart} className="label text-left px-1 py-1">
              SNAPSHOT
            </th>
            <th colSpan={HEAT_COLUMNS.length - flowStart} className={`label text-left px-1 py-1 border-l border-border ${noSource ? '!text-text-secondary' : ''}`} title={noSource}>
              {noSource ? 'FLOW · NO SOURCE' : 'FLOW'}
            </th>
            <th className="bg-panel" />
          </tr>
          <tr>
            <th className="sticky left-0 z-[3] bg-panel label text-left px-2 py-1">ASSET</th>
            {HEAT_COLUMNS.map((c, i) => (
              <th key={c.metric} title={c.title} className={`text-2xs uppercase tracking-wider text-text-secondary font-normal px-1 py-1 ${i === flowStart ? 'border-l border-border' : ''}`}>
                {c.header}
              </th>
            ))}
            <th className="label text-left px-2 py-1">FLAGS</th>
          </tr>
        </thead>
        <tbody>
          {data.rows.map((r) => {
            const rowFlags = firing.filter((f) => f.asset === r.asset)
            const col = focus?.asset === r.asset ? focus.col : -1
            return (
              <tr
                key={r.asset}
                tabIndex={0}
                aria-label={`${r.asset} ${r.held ? 'held' : 'watched'}${rowFlags.length ? ` · ${rowFlags.map(chipText).join(', ')}` : ''}`}
                aria-activedescendant={col >= 0 ? `heat-${r.asset}-${HEAT_COLUMNS[col]!.metric}` : undefined}
                onKeyDown={onKey(r.asset)}
                onBlur={() => setFocus((f) => (f?.asset === r.asset ? null : f))}
                onClick={() => navigate(assetHref(r.asset))}
                className="cursor-pointer focus-visible:outline focus-visible:outline-1 focus-visible:outline-text-secondary"
              >
                <td className="sticky left-0 z-[1] bg-panel px-2 whitespace-nowrap hover:bg-hover">
                  <span className="inline-flex items-baseline gap-1.5">
                    <span className="text-md text-text-primary">{r.asset}</span>
                    <span className={`text-2xs uppercase tracking-wider ${r.held ? 'text-text-primary' : 'text-text-secondary'}`}>{r.held ? 'HELD' : 'WATCH'}</span>
                  </span>
                </td>
                {HEAT_COLUMNS.map((c, i) => (
                  <HeatCell
                    key={c.metric}
                    asset={r.asset}
                    metric={c.metric}
                    window={window}
                    cell={cells.get(`${r.asset}:${c.metric}`)}
                    nullTitle={c.group === 'flow' ? noSource : undefined}
                    focused={i === col}
                    divider={i === flowStart}
                    onOpen={() => navigate(assetHref(r.asset, c.metric))}
                  />
                ))}
                <FlagsCell flags={rowFlags} />
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
