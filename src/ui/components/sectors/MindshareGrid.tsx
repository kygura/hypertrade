import type { Sector } from '../../../shared/types'
import { MomentumBadge } from '../MomentumBadge'

// MindshareGrid — DESIGN.md §10.5. Tiered heat-grid: cell SIZE tier from
// mindshare_score, cell BACKGROUND from the momentum ramp (§2 tokens).
// Deliberately not a treemap — see DESIGN.md's rationale for the decision.

export type EnrichedSector = Sector & { oi_usd_total: number; avg_funding: number; names_matched: number }

type Tier = 'lg' | 'md' | 'sm'

function tierOf(score: number): Tier {
  if (score >= 0.25) return 'lg'
  if (score >= 0.1) return 'md'
  return 'sm'
}

// col-span-2 reads as "half of 2 mobile cols" and "half of 4 desktop cols"
// at once — DESIGN's Large tier (2x1 mobile, 2x2 desktop) falls out of one
// class list plus a desktop-only row doubling.
const SPAN: Record<Tier, string> = {
  lg: 'col-span-2 lg:row-span-2',
  md: 'lg:col-span-2',
  sm: '',
}

function momentumBg(m: number): string {
  if (m >= 0.5) return 'var(--color-mom-pos2)'
  if (m >= 0.15) return 'var(--color-mom-pos1)'
  if (m <= -0.5) return 'var(--color-mom-neg2)'
  if (m <= -0.15) return 'var(--color-mom-neg1)'
  return 'var(--color-mom-zero)'
}

export function MindshareGrid({
  sectors,
  selectedId,
  onSelect,
}: {
  sectors: EnrichedSector[]
  selectedId: string | null
  onSelect: (id: string) => void
}) {
  const sorted = [...sectors].sort((a, b) => b.mindshare_score - a.mindshare_score)

  return (
    <div
      className="grid grid-cols-2 lg:grid-cols-4 auto-rows-[64px] lg:auto-rows-[72px] gap-[2px]"
      style={{ background: 'var(--color-body)' }}
    >
      {sorted.map((s) => {
        const selected = s.id === selectedId
        return (
          <button
            key={s.id}
            type="button"
            onClick={() => onSelect(s.id)}
            aria-pressed={selected}
            className={`text-left flex flex-col justify-between p-2 min-w-0 ${SPAN[tierOf(s.mindshare_score)]}`}
            style={{
              background: momentumBg(s.momentum),
              boxShadow: selected
                ? 'inset 2px 0 0 var(--color-red-accent), inset 0 0 0 999px var(--color-selected)'
                : undefined,
            }}
          >
            <span className="text-[12px] uppercase text-text-primary line-clamp-2">{s.label}</span>
            <span className="flex items-end justify-between gap-1">
              <span className="text-[10px] text-text-secondary tabular">MS {s.mindshare_score.toFixed(2)}</span>
              <MomentumBadge momentum={s.momentum} />
            </span>
          </button>
        )
      })}
    </div>
  )
}
