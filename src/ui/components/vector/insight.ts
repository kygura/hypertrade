import type { VectorResponse } from '../../../shared/vector'
import { daysBetween, fmtDeltaPts, fmtInt } from './format'
import { REGIME_WORD } from './scales'

/**
 * The one fact line at the top of /htf, built only from payload fields: the
 * regime the model reads and for how long, how many stress conditions are
 * active, where price sits against the 200-day average, and the compass
 * headline with its 30-day change. Parts with no data are left out; null when
 * the model has no regime reading at all.
 */
export function regimeInsight(v: Pick<VectorResponse, 'asOf' | 'regime' | 'levels' | 'compass'>): string | null {
  const { state, since, conditions } = v.regime
  if (!state) return null
  const days = since != null && v.asOf != null ? daysBetween(since, v.asOf) : null
  const parts = [`The model reads ${REGIME_WORD[state].toLowerCase()}${days == null ? '' : ` for ${days} ${days === 1 ? 'day' : 'days'}`}`]
  if (conditions.length > 0) parts.push(`${conditions.filter((c) => c.on).length} of ${conditions.length} stress conditions are active`)
  const d = v.levels.find((l) => l.key === 'sma200')?.distancePct
  if (d != null) parts.push(`price is ${Math.abs(d).toFixed(1)}% ${d < 0 ? 'below' : 'above'} the 200-day average`)
  const { score, band, d30 } = v.compass.headline
  if (score != null) parts.push(`compass headline ${fmtInt(score)}${band ? ` (${band})` : ''}${d30 == null ? '' : `, ${fmtDeltaPts(d30)} points over 30 days`}`)
  return parts.join('; ') + '.'
}
