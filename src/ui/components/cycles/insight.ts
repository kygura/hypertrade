import type { CycleForecast } from '../../../shared/cycleForecast'
import { fmtDay, fmtMonth } from './format'

/**
 * The one fact line at the top of /cycles, from the forecast's readiness block:
 * the phase the model reads and since when, days since the latest cycle top and
 * the distance from it, how that time compares with past top-to-next-run gaps
 * (n = completed gaps), and the pooled run-start window when there is one.
 * Null before the model has seen a bull run.
 */
export function cycleInsight(f: Pick<CycleForecast, 'readiness' | 'episodes' | 'onset' | 'kind'>, coin: string): string | null {
  const r = f.readiness
  const top = f.episodes[f.episodes.length - 1]?.top
  if (!r || !top) return null
  const parts: string[] = []
  if (r.phase) parts.push(`The model reads ${coin} in ${r.phase}${r.phaseSince == null ? '' : ` since ${fmtDay(r.phaseSince)}`}`)
  const off = Math.abs(r.drawdown * 100).toFixed(1)
  parts.push(`${r.daysSinceTop.toLocaleString('en-US')} days since the ${fmtMonth(top.t)} cycle top, price ${off}% ${r.drawdown > 0 ? 'above' : 'below'} it`)
  const gaps = f.episodes.length - 1
  if (r.elapsed != null && gaps > 0) parts.push(`that is ${Math.round(r.elapsed * 100)}% of the median gap from a top to the next run start (n ${gaps} past ${gaps === 1 ? 'gap' : 'gaps'})`)
  if (f.onset) parts.push(`past gaps put the next ${f.kind === 'breakout' ? 'breakout' : 'euphoria onset'} between ${fmtMonth(f.onset.p25)} and ${fmtMonth(f.onset.p75)} (middle half of the estimates)`)
  return parts.join('; ') + '.'
}
