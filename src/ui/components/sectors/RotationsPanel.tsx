import type { Rotation } from '../../../shared/types'
import { EmptyBlock } from '../state'
import { Badge } from '../Badge'
import { HowToRead, type Term } from '../HowToRead'

// RotationsPanel — docs/design/README.md §10.5. `rotations[]`: FROM→TO, confidence
// badge, trigger, note (§4.4 drop order: note is md+ only, 2-line clamp).

const TERMS: readonly Term[] = [
  ['FROM → TO', 'The sector the routine sees attention leaving and the one it sees it entering.'],
  ['CONFIDENCE', 'The routine\'s own confidence from 0 to 1. It is not a measured probability. Grey below 0.5.'],
  ['Second line', 'The trigger: a checkable condition (a named metric, a threshold and a direction) the routine says would confirm the rotation.'],
  ['Third line', 'The routine\'s note on why it flagged it. Hidden on phones.'],
]

const GUIDE = (
  <HowToRead terms={TERMS}>
    Moves of attention from one sector to another, as flagged by the scheduled routine. Each is a hypothesis with the condition that
    would confirm it, not a measured flow.
  </HowToRead>
)

export function RotationsPanel({
  rotations,
  sectorLabel,
}: {
  rotations: Rotation[]
  sectorLabel: (id: string) => string
}) {
  if (rotations.length === 0)
    return (
      <div className="flex flex-col gap-2">
        {GUIDE}
        <EmptyBlock label="No rotations flagged. The routine lists one when it sees attention moving between two sectors; its last run saw none." />
      </div>
    )

  return (
    <div className="flex flex-col gap-2">
      {GUIDE}
    <div className="divide-y divide-border-subtle">
      {rotations.map((r, i) => (
        <div key={i} className="p-2 flex flex-col gap-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm text-text-primary uppercase">
              {sectorLabel(r.from)} <span className="text-text-secondary">→</span> {sectorLabel(r.to)}
            </span>
            <Badge tone={r.confidence < 0.5 ? 'gray' : 'neutral'}>CONFIDENCE {r.confidence.toFixed(2)}</Badge>
          </div>
          <span className="text-xs text-text-secondary">{r.trigger}</span>
          <span className="hidden md:block text-xs text-text-muted line-clamp-2">{r.note}</span>
        </div>
      ))}
    </div>
    </div>
  )
}
