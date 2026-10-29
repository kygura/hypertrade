import { fmtTs, fmtTsSec, fmtDur, fmtAge, fmtUsdSigned } from '../../lib/format'
import type { IntentAction, VerdictStatus } from '../../../shared/strategy-protocol'

// Formatting helpers shared by the strategy console. Timestamps print in UTC
// (`2026-09-23 08:05 UTC`) like the rest of the app's routine stamps.

export { fmtTs, fmtTsSec, fmtDur, fmtAge }

export function fmtProb(p: number | null | undefined): string {
  if (p == null || Number.isNaN(p)) return '—'
  return p.toFixed(2)
}

export { fmtUsdSigned }

export const ACTION_LABEL: Record<IntentAction, string> = {
  open_long: 'OPEN LONG',
  open_short: 'OPEN SHORT',
  close: 'CLOSE',
  scale: 'SCALE',
  rebalance: 'REBALANCE',
  hold: 'HOLD',
}

/** Direction hue for an action; the label always carries the word (§2.1). */
export function actionClass(action: IntentAction): string {
  switch (action) {
    case 'open_long':
      return 'text-green'
    case 'open_short':
      return 'text-red-text'
    case 'scale':
    case 'rebalance':
      return 'text-info'
    default:
      return 'text-text-muted'
  }
}

export const VERDICT_TONE: Record<VerdictStatus, 'green' | 'red' | 'amber' | 'info' | 'gray'> = {
  proposed: 'amber',
  approved: 'info',
  executed: 'green',
  rejected: 'red',
  failed: 'red',
  gated: 'gray',
}
