import type { IntentAction, VerdictStatus } from '../../../shared/strategy-protocol'

// Formatting helpers shared by the strategy console. Timestamps print in UTC
// (`2026-09-23 08:05 UTC`) like the rest of the app's routine stamps.

export function fmtTs(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
}

export function fmtTsSec(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
}

export function fmtAge(iso: string | null | undefined): string {
  if (!iso) return '—'
  const ms = Date.now() - new Date(iso).getTime()
  if (Number.isNaN(ms)) return iso
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}S AGO`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}M AGO`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}H AGO`
  return `${Math.floor(h / 24)}D AGO`
}

export function fmtProb(p: number | null | undefined): string {
  if (p == null || Number.isNaN(p)) return '—'
  return p.toFixed(2)
}

export function fmtUsdSigned(n: number | null | undefined): string {
  if (n == null) return '—'
  const sign = n < 0 ? '−' : n > 0 ? '+' : ''
  return `${sign}$${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 2 })}`
}

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
