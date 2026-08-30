import type { Rotation } from '../../../shared/types'
import { EmptyBlock } from '../state'
import { Badge } from '../Badge'

// RotationsPanel — DESIGN.md §10.5. `rotations[]`: FROM→TO, confidence
// badge, trigger, note (§4.4 drop order: note is md+ only, 2-line clamp).

export function RotationsPanel({
  rotations,
  sectorLabel,
}: {
  rotations: Rotation[]
  sectorLabel: (id: string) => string
}) {
  if (rotations.length === 0) return <EmptyBlock label="no rotations flagged" />

  return (
    <div className="divide-y divide-border-subtle">
      {rotations.map((r, i) => (
        <div key={i} className="p-2 flex flex-col gap-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[11px] text-text-primary uppercase">
              {sectorLabel(r.from)} <span className="text-text-secondary">→</span> {sectorLabel(r.to)}
            </span>
            {r.confidence < 0.5 ? (
              <Badge tone="gray">CONF {r.confidence.toFixed(2)}</Badge>
            ) : (
              <span className="inline-flex items-center px-1.5 py-0.5 text-[10px] tabular border border-transparent text-text-primary bg-elevated font-mono">
                CONF {r.confidence.toFixed(2)}
              </span>
            )}
          </div>
          <span className="text-[10px] text-text-secondary">{r.trigger}</span>
          <span className="hidden md:block text-[10px] text-text-muted line-clamp-2">{r.note}</span>
        </div>
      ))}
    </div>
  )
}
