import { useState } from 'react'
import { Link } from 'react-router'
import { LeanBar } from '../LeanBar'
import { RuleText } from '../RuleText'
import { fmtSigned, sortPulse, type CatalogueListEntry, type MetricDef, type PulseAsset } from '../../lib/lab'
import { DirectionWord } from './common'

// PulseBoard — DESIGN.md §10.9. One row per asset, sorted by |lean|: LeanBar
// + the signed LEAN number, active/total counts, and a chevron that lists
// the asset's catalogued rules (row → the rule drill).

export function PulseBoard({ assets, entries, metrics }: { assets: PulseAsset[]; entries: CatalogueListEntry[]; metrics: readonly MetricDef[] }) {
  return (
    <ul className="flex flex-col">
      {sortPulse(assets).map((a) => (
        <PulseAssetRow key={a.asset} asset={a} entries={entries} metrics={metrics} />
      ))}
    </ul>
  )
}

function Count({ label, active, total }: { label: string; active: number; total: number }) {
  return (
    <span>
      {label} <span className={active > 0 ? 'text-text-primary' : undefined}>{active}</span>/{total}
    </span>
  )
}

export function PulseAssetRow({ asset: a, entries, metrics }: { asset: PulseAsset; entries: CatalogueListEntry[]; metrics: readonly MetricDef[] }) {
  const [open, setOpen] = useState(false)
  const listId = `pulse-${a.asset}`
  const leanTone = a.lean > 0 ? 'text-green' : a.lean < 0 ? 'text-red-text' : 'text-text-secondary'
  return (
    <li className="border-b border-border-subtle">
      <div className="flex flex-col md:flex-row md:items-center gap-1.5 md:gap-4 px-3 py-2">
        <div className="flex items-center gap-3 min-w-0">
          <span className="text-sm font-semibold w-[7ch] flex-shrink-0">{a.asset.toUpperCase()}</span>
          <span className="flex flex-1 max-w-[200px] md:flex-none md:w-[120px]">
            <LeanBar lean={a.lean} width="100%" />
          </span>
          <span className={`text-sm tabular whitespace-nowrap ${leanTone}`}>LEAN {fmtSigned(a.lean)}</span>
        </div>
        <div className="flex items-center gap-3 md:flex-1">
          <span className="text-xs tabular text-text-secondary">
            <Count label="LONG" active={a.longActive} total={a.longTotal} /> · <Count label="SHORT" active={a.shortActive} total={a.shortTotal} />
          </span>
          <button
            type="button"
            aria-expanded={open}
            aria-controls={listId}
            aria-label={`${open ? 'hide' : 'show'} ${a.asset} rules`}
            onClick={() => setOpen(!open)}
            className="ml-auto min-w-[var(--tap-min)] min-h-[var(--tap-min)] text-text-secondary hover:text-text-primary"
          >
            {open ? '▾' : '▸'}
          </button>
        </div>
      </div>
      {open && (
        <ul id={listId} className="pb-1">
          {a.rules.map((r) => {
            const rule = entries.find((e) => e.id === r.id)?.rule
            return (
              <li key={r.id}>
                <Link
                  to={`/lab/rules/${encodeURIComponent(r.id)}?from=pulse`}
                  className="grid grid-cols-[auto_minmax(0,auto)_auto_minmax(0,1fr)] items-center gap-2 pl-6 pr-3 min-h-[var(--row-h)] hover:bg-hover"
                >
                  <span className={r.firing ? 'text-green' : 'text-text-secondary'} title={r.firing ? 'firing' : 'flat'}>
                    <span aria-hidden="true">{r.firing ? '●' : '○'}</span>
                    <span className="sr-only">{r.firing ? 'firing' : 'flat'}</span>
                  </span>
                  <span className="text-sm text-text-primary truncate">{r.name}</span>
                  <DirectionWord direction={r.direction} className="text-xs" />
                  {rule ? (
                    <RuleText rule={rule} metrics={metrics} size="xs" className="text-text-secondary truncate block" />
                  ) : (
                    <span className="text-xs text-text-secondary truncate">{r.text}</span>
                  )}
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </li>
  )
}
