import type { LabRuleReport, LabStats } from '../../../shared/lab'
import type { Tone } from '../Badge'

// Verdict on a rule report, from the numbers the search could not tune:
// the holdout, the deflated Sharpe and threshold stability.
export function verdict(r: LabRuleReport): { label: string; tone: Tone; title: string } {
  const oos = r.outOfSample?.sharpe ?? NaN
  const dsr = r.deflatedSharpe ?? 0
  const stab = r.stability ?? 1
  if (!(oos > 0)) return { label: 'FAILS HOLDOUT', tone: 'red', title: 'Sharpe on the unseen 20% holdout is not positive' }
  if (dsr >= 0.95 && stab >= 0.5) return { label: 'ROBUST', tone: 'green', title: 'Holds on the holdout, deflated Sharpe >= 0.95, stable thresholds' }
  if (stab < 0.5) return { label: 'FRAGILE', tone: 'amber', title: 'Holds on the holdout, but neighbouring thresholds lose most of the edge' }
  return { label: 'HOLDS · UNPROVEN', tone: 'amber', title: 'Holds on the holdout, but the deflated Sharpe cannot rule out a lucky draw among all variants tried' }
}

export const fmtNum = (v: number | null | undefined, d = 2) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(d))
export const fmtPctPre = (v: number | null | undefined, d = 1) =>
  v === null || v === undefined || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(d)}%`
export const fmtShare = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : `${Math.round(v * 100)}%`)
export const signTone = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) || v === 0 ? 'text-text-secondary' : v > 0 ? 'text-green' : 'text-red-text')

export const STAT_ROWS: { label: string; get: (s: LabStats) => string; tone?: (s: LabStats) => string }[] = [
  { label: 'SHARPE', get: (s) => fmtNum(s.sharpe), tone: (s) => signTone(s.sharpe) },
  { label: 'CAGR', get: (s) => fmtPctPre(s.cagrPct), tone: (s) => signTone(s.cagrPct) },
  { label: 'MAX DD', get: (s) => fmtPctPre(s.maxDrawdownPct) },
  { label: 'IN MKT', get: (s) => fmtShare(s.exposure) },
  { label: 'TRADES', get: (s) => (Number.isFinite(s.trades) ? String(s.trades) : '—') },
  { label: 'WIN', get: (s) => fmtShare(s.winRate) },
]
