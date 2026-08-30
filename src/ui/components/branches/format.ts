// Formatting + small pure helpers shared by the branch views and charts.
// Colocated here (not lib/) since lib/api.ts is outside this worker's
// write set — see the task's strict write-set note.
import type { Allocation, BranchConfig } from '../../../shared/types'
import type { EquityPoint } from './types'

const MINUS = '−'

export const STABLE_COINS = new Set(['USDC', 'USDT'])

export function fmtUsd(value: number): string {
  return `$${Math.round(value).toLocaleString('en-US')}`
}

export function fmtUsdCompact(value: number): string {
  const sign = value < 0 ? '-' : ''
  return `${sign}$${new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(Math.abs(value))}`
}

export function fmtPct(value: number, digits = 1): string {
  const sign = value >= 0 ? '+' : MINUS
  return `${sign}${Math.abs(value).toFixed(digits)}%`
}

export function signClass(value: number): string {
  if (value > 0) return 'text-green'
  if (value < 0) return 'text-red-text'
  return 'text-text-secondary'
}

// MAX DD: signed negative, red text only past -20% (DESIGN.md §10.3).
// Engine reports maxDrawdownPct as a positive magnitude.
export function maxDdClass(magnitudePct: number): string {
  return Math.abs(magnitudePct) >= 20 ? 'text-red-text' : 'text-text-primary'
}

export function allocationSummary(allocations: Allocation[]): string {
  if (allocations.length === 0) return '—'
  return allocations.map((a) => `${Math.round(a.weightPct)} ${a.coin || '?'}`).join(' / ')
}

const REBALANCE_LABEL: Record<BranchConfig['rebalance'], string> = {
  none: 'NO REBAL',
  monthly: 'MONTHLY',
  weekly: 'WEEKLY',
  threshold5pct: '5% BAND',
}
export function rebalanceLabel(mode: BranchConfig['rebalance']): string {
  return REBALANCE_LABEL[mode]
}

export function oneYearAgoISODate(): string {
  const d = new Date()
  d.setUTCFullYear(d.getUTCFullYear() - 1)
  return d.toISOString().slice(0, 10)
}

// DESIGN.md §10.3: NEW BRANCH default — UNTITLED, 100% USDC, 1y ago, $10k, no rebalance.
export function defaultBranchConfig(): BranchConfig {
  return {
    startDate: oneYearAgoISODate(),
    initialCapitalUsd: 10000,
    allocations: [{ coin: 'USDC', weightPct: 100 }],
    rebalance: 'none',
  }
}

export function sumWeights(allocations: Allocation[]): number {
  return allocations.reduce((s, a) => s + (Number.isFinite(a.weightPct) ? a.weightPct : 0), 0)
}

// Percent-from-peak drawdown series, values <= 0 (DESIGN.md §9.2).
export function computeDrawdown(equity: EquityPoint[]): EquityPoint[] {
  let peak = -Infinity
  const out: EquityPoint[] = []
  for (const p of equity) {
    if (p.value > peak) peak = p.value
    out.push({ ts: p.ts, value: peak > 0 ? ((p.value - peak) / peak) * 100 : 0 })
  }
  return out
}

export function fmtChartDate(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`
}
