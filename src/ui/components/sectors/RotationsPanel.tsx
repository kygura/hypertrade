import type { Rotation } from '../../../shared/types'
import { EmptyBlock } from '../state'
import { Badge } from '../Badge'

// RotationsPanel — docs/design/README.md §10.5. `rotations[]`: FROM→TO, confidence
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
            <span className="text-sm text-text-primary uppercase">
              {sectorLabel(r.from)} <span className="text-text-secondary">→</span> {sectorLabel(r.to)}
            </span>
            <Badge tone={r.confidence < 0.5 ? 'gray' : 'neutral'}>CONF {r.confidence.toFixed(2)}</Badge>
          </div>
          <span className="text-xs text-text-secondary">{r.trigger}</span>
          <span className="hidden md:block text-xs text-text-muted line-clamp-2">{r.note}</span>
        </div>
      ))}
    </div>
  )
}
