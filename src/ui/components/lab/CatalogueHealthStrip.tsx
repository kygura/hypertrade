import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { Badge } from '../Badge'
import { Button } from '../Button'
import { AgeStamp, AsyncBody } from '../state'
import { fmtSigned, type CatalogueHealth, type CatalogueListEntry, type LabState } from '../../lib/lab'

// CatalogueHealthStrip — docs/design/README.md §10.9. DECAYED · OVERLAPS · GAPS as ghost
// toggles (amber when > 0); each expands its list. Health is computed on
// request, so its age is the fetch time. Fails on its own: the table below
// still renders.

type Open = 'decayed' | 'overlaps' | 'gaps' | null

export function CatalogueHealthStrip({ health, entries }: { health: LabState<CatalogueHealth>; entries: CatalogueListEntry[] }) {
  const navigate = useNavigate()
  const [open, setOpen] = useState<Open>(null)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const fetchedAt = useMemo(() => new Date().toISOString(), [health.data])
  const nameOf = (id: string) => entries.find((e) => e.id === id)?.name ?? id.slice(0, 8)

  return (
    <AsyncBody {...health} rows={1} staleError={false} onRetry={health.refetch}>
      {(h) => {
      const counters: Array<{ key: Exclude<Open, null>; label: string; n: number; title: string }> = [
        { key: 'decayed', label: 'DECAYED', n: h.decayed.length, title: 'rules whose live Sharpe has fallen below 0 or below a quarter of their holdout Sharpe. Click to list' },
        { key: 'overlaps', label: 'OVERLAPS', n: h.overlaps.length, title: 'pairs of rules on the same asset and side that are in the market on mostly the same days. Click to list' },
        { key: 'gaps', label: 'GAPS', n: h.gaps.length, title: 'assets with no saved rule on one side. Click to list' },
      ]

      return (
        <div className="border-b border-border-subtle">
          <div className="flex flex-wrap items-center gap-2 px-3 py-2">
            {counters.map((c) => (
              <Button key={c.key} tier="ghost" title={c.title} aria-pressed={open === c.key} aria-controls="lab-health-list" onClick={() => setOpen(open === c.key ? null : c.key)}>
                <span className={c.n > 0 ? 'text-amber' : 'text-text-secondary'}>
                  {c.label} {c.n}
                </span>
              </Button>
            ))}
            <span className="ml-auto">
              <AgeStamp generatedAt={fetchedAt} thresholdHours={48} />
            </span>
          </div>
          {open && (
            <ul id="lab-health-list" className="flex flex-col pb-2">
              {open === 'decayed' &&
                (h.decayed.length === 0 ? (
                  <li className="px-3 text-xs text-text-secondary">no decayed rules: none has a live Sharpe below 0 or below a quarter of its holdout Sharpe after 30 live days</li>
                ) : (
                  h.decayed.map((d) => (
                    <li key={d.id} className="flex flex-wrap items-center gap-2 px-3 min-h-[var(--row-h)] text-sm tabular">
                      <span className="text-text-primary">{d.name}</span>
                      <span className="text-text-secondary">· live {d.liveDays}d · live {fmtSigned(d.liveSharpe)} vs holdout {fmtSigned(d.holdoutSharpe)}</span>
                      <Badge tone="amber">DECAYED</Badge>
                    </li>
                  ))
                ))}
              {open === 'overlaps' &&
                (h.overlaps.length === 0 ? (
                  <li className="px-3 text-xs text-text-secondary">no overlapping rules: no two on the same asset and side are in the market on mostly the same days</li>
                ) : (
                  h.overlaps.map((o) => (
                    <li key={`${o.a}-${o.b}`} className="px-3 min-h-[var(--row-h)] flex items-center text-sm tabular">
                      {nameOf(o.a)} ↔ {nameOf(o.b)}{' '}
                      <span className="text-text-secondary" title="share of the days either rule is in the market on which both are (Jaccard overlap)">
                        &nbsp;· shared days {o.jaccard.toFixed(2)}
                      </span>
                    </li>
                  ))
                ))}
              {open === 'gaps' &&
                (h.gaps.length === 0 ? (
                  <li className="px-3 text-xs text-text-secondary">no gaps: every asset in the catalogue has a rule on both sides</li>
                ) : (
                  h.gaps.map((g) => (
                    <li key={`${g.asset}-${g.direction}`} className="flex flex-wrap items-center gap-2 px-3 min-h-[var(--row-h)] text-sm">
                      <span>
                        {g.asset.toUpperCase()} {g.direction.toUpperCase()} <span className="text-text-secondary">: no saved rule on this side</span>
                      </span>
                      <Button tier="ghost" onClick={() => navigate('/lab/search', { state: { prefill: { asset: g.asset, direction: g.direction } } })}>
                        SEARCH →
                      </Button>
                    </li>
                  ))
                ))}
            </ul>
          )}
        </div>
      )
      }}
    </AsyncBody>
  )
}
