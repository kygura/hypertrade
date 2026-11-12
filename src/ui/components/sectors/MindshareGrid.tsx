import { fmtPct } from '../../../shared/format'
import type { Sector } from '../../../shared/types'
import { HowToRead, type Term } from '../HowToRead'
import { MomentumBadge } from '../MomentumBadge'
import { mindshareInsight } from './insight'

// MindshareGrid — docs/design/README.md §10.5. Tiered heat-grid: cell SIZE tier from
// mindshare_score, cell BACKGROUND from the momentum ramp (§2 tokens).
// Deliberately not a treemap — see docs/design/README.md's rationale for the decision.

// Per-matched-token row from GET /api/sectors enrichment (docs/design/README.md §10.5
// drill-in table): TOKEN/PRICE/24H%/OI/FUNDING, mirrors
// src/server/routes/sectors.ts's SectorTokenRow.
export interface SectorTokenRow {
  coin: string
  markPx: number
  dayChangePct: number
  openInterestUsd: number
  funding: number
  /** Elfa, trailing 24h; absent without a recent sample. */
  mentions24h?: number
  share24h?: number
  mentionsChg24h?: number
}

export type EnrichedSector = Sector & {
  oi_usd_total: number
  avg_funding: number
  names_matched: number
  tokenRows: SectorTokenRow[]
  /** Measured attention (Elfa) beside the routine's judged mindshare_score; null without data. */
  social_mentions_24h?: number | null
  social_share_24h?: number | null
  social_as_of?: string | null
}

const TERMS: readonly Term[] = [
  ['Tile size', 'The mindshare score: large from 0.25, medium from 0.10, small below. Tiles are sorted by it.'],
  ['mindshare', 'From 0 to 1: how much of the market\'s attention the routine judges this sector to hold. A judgment by the scheduled model run, written from measured open interest, funding, 24-hour change and social share.'],
  ['social', 'Measured, unlike mindshare: the sector\'s share of crypto-social mentions over the last 24 hours, summed over its tokens (Elfa). Shown only when a recent sample exists.'],
  ['Tile colour · ▲ ▼ badge', 'The momentum score, from −1 to +1: whether the routine judges attention to be building or fading. Also the routine\'s judgment. Green from +0.15 and stronger green from +0.5; red from −0.15 and stronger red from −0.5; grey in between.'],
  ['Click', 'Opens the sector below with the routine\'s reasoning and live numbers for its tokens.'],
]

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
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-1">
        <p className="text-md text-text-primary">{mindshareInsight(sectors)}</p>
        <HowToRead terms={TERMS}>
          One tile per sector. Size is the mindshare score and colour is the momentum score, both judged by the scheduled routine from
          measured market data. Look for large tiles changing colour, and for mindshare that differs from measured social share.
        </HowToRead>
      </div>
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
            <span className="text-md uppercase text-text-primary line-clamp-2">{s.label}</span>
            <span className="flex items-end justify-between gap-1">
              <span className="text-xs text-text-secondary tabular">
                <span title="Mindshare score, 0 to 1: the routine's judgment of attention">mindshare</span> {s.mindshare_score.toFixed(2)}
                {s.social_share_24h != null && (
                  <span title="Share of crypto-social mentions, trailing 24h (Elfa). Measured, unlike MS, which is the routine's judgment.">
                    {' · '}social {fmtPct(s.social_share_24h, { decimals: 1 })}
                  </span>
                )}
              </span>
              <MomentumBadge momentum={s.momentum} />
            </span>
          </button>
        )
      })}
    </div>
    </div>
  )
}
