import type { MarketStateDomain } from '../../../shared/types'
import { Panel, PanelHeader, PanelBody } from '../Panel'

// DomainCard + SignalRow — DESIGN.md §10.6. Panel per domains[] entry:
// summary, then one row per signal (label + tabular value + direction
// glyph). Direction word lives in the glyph + value sign; label carries
// the semantics.

function glyph(direction: string): { icon: string; cls: string } {
  if (direction === 'up') return { icon: '▲', cls: 'text-green' }
  if (direction === 'down') return { icon: '▼', cls: 'text-red-text' }
  return { icon: '—', cls: 'text-text-secondary' }
}

export function DomainCard({ domain }: { domain: MarketStateDomain }) {
  return (
    <Panel>
      <PanelHeader title={domain.domain.toUpperCase()} />
      <PanelBody className="p-3 flex flex-col gap-2">
        <p className="text-[13px] text-text-muted">{domain.summary}</p>
        <div className="flex flex-col gap-1">
          {domain.signals.map((sig, i) => {
            const g = glyph(sig.direction)
            return (
              <div key={i} className="flex items-center justify-between gap-2">
                <span className="text-[10px] uppercase text-text-secondary">{sig.label}</span>
                <span className="text-[11px] tabular text-text-primary flex items-center gap-1">
                  {sig.value}
                  <span className={g.cls}>{g.icon}</span>
                </span>
              </div>
            )
          })}
        </div>
      </PanelBody>
    </Panel>
  )
}
