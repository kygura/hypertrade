import type { NarrativeRow, NarrativeStage } from '../../../shared/intel'
import type { Sector } from '../../../shared/types'
import { fmtSigned } from '../../lib/format'

// Fact lines for /sectors. Counts and the extreme row only: a stage or a
// momentum score is a reading (code for stages, the routine's judgment for
// mindshare and momentum), and the line says which.

/** Momentum at or past this reads as rising/falling (MomentumBadge and the grid's colour ramp use the same edge). */
export const MOMENTUM_EDGE = 0.15

const STAGE_ORDER: readonly NarrativeStage[] = ['crowded', 'expanding', 'emerging', 'fading', 'quiet', 'unknown']

/** Narratives table: how many baskets sit in each stage, and the widest 7-day gap to BTC. Null with no rows. */
export function narrativesInsight(rows: Pick<NarrativeRow, 'label' | 'stage' | 'htf'>[]): string | null {
  if (rows.length === 0) return null
  const counts = STAGE_ORDER.map((s) => [s, rows.filter((r) => r.stage === s).length] as const).filter(([, n]) => n > 0)
  const parts = [`${rows.length} ${rows.length === 1 ? 'narrative' : 'narratives'} by stage: ${counts.map(([s, n]) => `${n} ${s}`).join(', ')}`]
  const rel = rows.filter((r) => r.htf.relBtc7d != null)
  if (rel.length > 0) {
    const top = rel.reduce((a, r) => (Math.abs(r.htf.relBtc7d!) > Math.abs(a.htf.relBtc7d!) ? r : a))
    parts.push(`widest 7-day gap to BTC is ${top.label} at ${fmtSigned(top.htf.relBtc7d, 'pp', 1)}`)
  }
  return parts.join('; ') + '.'
}

/** Mindshare grid: the sector the routine scored highest, and how many it scored rising or falling. Null with no sectors. */
export function mindshareInsight(sectors: Pick<Sector, 'label' | 'mindshare_score' | 'momentum'>[]): string | null {
  if (sectors.length === 0) return null
  const top = sectors.reduce((a, s) => (s.mindshare_score > a.mindshare_score ? s : a))
  const up = sectors.filter((s) => s.momentum >= MOMENTUM_EDGE).length
  const down = sectors.filter((s) => s.momentum <= -MOMENTUM_EDGE).length
  return `The routine scored ${sectors.length} ${sectors.length === 1 ? 'sector' : 'sectors'}: highest mindshare is ${top.label} at ${top.mindshare_score.toFixed(2)}; momentum is +${MOMENTUM_EDGE} or more on ${up} and −${MOMENTUM_EDGE} or less on ${down}.`
}
