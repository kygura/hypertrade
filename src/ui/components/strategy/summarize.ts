import type { DecisionRecord } from '../../../shared/strategy-protocol'
import { ACTION_LABEL, actionClass } from './format'

/**
 * One-line action summary of a decision. No decision: `fallback` (muted) or an em dash.
 * `dry` appends ` (DRY)` for dry runs.
 */
export function summarizeDecision(
  d: DecisionRecord | undefined,
  opts: { fallback?: string | null; dry?: boolean } = {},
): { text: string; className: string } {
  if (!d) return opts.fallback ? { text: opts.fallback, className: 'text-text-muted' } : { text: '—', className: 'text-text-secondary' }
  if (d.error) return { text: 'ERROR', className: 'text-red-text' }
  const first = d.intents[0]
  if (!first) return { text: 'HOLD', className: 'text-text-muted' }
  const more = d.intents.length > 1 ? ` +${d.intents.length - 1}` : ''
  const dry = opts.dry && d.dry_run ? ' (DRY)' : ''
  return { text: `${ACTION_LABEL[first.action]} ${first.market}${more}${dry}`, className: actionClass(first.action) }
}
