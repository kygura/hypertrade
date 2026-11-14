// Formatting + small pure helpers shared by the branch views and charts.
// Colocated here (not lib/) since lib/api.ts is outside this worker's
// write set — see the task's strict write-set note.
//
// fmtUsd/fmtPct used to be reimplemented here with a DIFFERENT unit contract
// than shared/format.ts (this file's old fmtPct took a pre-scaled percent;
// shared's takes a fraction) — a silent-100x-bug trap. Consolidated: import
// fmtUsd/fmtPct from shared/format.ts everywhere. Engine sim stats
// (cagrPct, maxDrawdownPct, vsBtcPct, vsUsdcPct) are pre-scaled percents, so
// call sites divide by 100 before passing them to shared's fmtPct.
import { fmtUsdCompact, signClass } from '../../lib/format'
import type { Allocation, BranchConfig } from '../../../shared/types'
import type { EquityPoint } from './types'

export { fmtUsdCompact, signClass }

// MAX DD: signed negative, red text only past -20% (docs/design/README.md §10.3).
// Engine reports maxDrawdownPct as a positive magnitude.
export function maxDdClass(magnitudePct: number): string {
  return Math.abs(magnitudePct) >= 20 ? 'text-red-text' : 'text-text-primary'
}

export function allocationSummary(allocations: Allocation[], dca?: BranchConfig['dca']): string {
  if (allocations.length === 0) return '—'
  const legs = allocations
    .map((a) => {
      const lev = (a.leverage ?? 1) > 1 ? ` ${a.leverage}×` : ''
      return `${Math.round(a.weightPct)} ${a.coin || '?'}${a.side === 'short' ? ' SHORT' : ''}${lev}`
    })
    .join(' / ')
  return dca?.length ? `${legs} + DCA` : legs
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

function oneYearAgoISODate(): string {
  const d = new Date()
  d.setUTCFullYear(d.getUTCFullYear() - 1)
  return d.toISOString().slice(0, 10)
}

// docs/design/README.md §10.3: NEW BRANCH default — UNTITLED, 100% USDC, 1y ago, $10k, no rebalance.
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

// Percent-from-peak drawdown series, values <= 0 (docs/design/README.md §9.2).
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

const usd0 = (x: number) => '$' + Math.round(x).toLocaleString('en-US')
const pct1 = (x: number) => `${Math.abs(x).toFixed(1)}%`

/**
 * A simulated branch in one line: start capital and date, end value and date, the deepest fall from a peak, and where
 * it ended against holding BTC over the same days. Facts about a historical simulation; null without an equity curve.
 */
export function branchLine(
  result: { equity: EquityPoint[]; benchmarks: { btc: EquityPoint[] }; stats: { finalValue: number; maxDrawdownPct: number; vsBtcPct: number } },
  initialCapitalUsd: number,
): string | null {
  const first = result.equity[0]
  const last = result.equity.at(-1)
  if (!first || !last || !(initialCapitalUsd > 0)) return null
  const day = (ts: number) => new Date(ts).toISOString().slice(0, 10)
  const days = Math.round((last.ts - first.ts) / 86_400_000)
  const ret = (result.stats.finalValue / initialCapitalUsd - 1) * 100
  const btc = result.benchmarks.btc.at(-1)?.value
  const vs = result.stats.vsBtcPct
  const btcText = btc == null ? '' : ` Holding BTC over the same days ended at ${usd0(btc)}: the branch ended ${Math.abs(vs) < 0.05 ? 'level with' : `${pct1(vs)} ${vs > 0 ? 'above' : 'below'}`} that.`
  return `${usd0(initialCapitalUsd)} on ${day(first.ts)} became ${usd0(result.stats.finalValue)} by ${day(last.ts)} (${ret >= 0 ? '+' : '−'}${pct1(ret)} over ${days} days). Deepest fall from a peak: ${pct1(result.stats.maxDrawdownPct)}.${btcText}`
}
