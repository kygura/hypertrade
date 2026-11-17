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
/** One line per scheduled move: when it filled (or was asked for), the window it was picked from, and the holdings after it. */
export function moveLines(
  schedule: NonNullable<BranchConfig['schedule']>,
  filled: { step: number; date: string }[] = [],
): { when: string; window?: string; note?: string; holdings: string }[] {
  const at = new Map(filled.map((m) => [m.step, m.date]))
  return schedule.map((s, i) => ({
    when: at.get(i) ?? s.date,
    window: s.until ? `${s.at === 'high' ? 'HIGH' : 'LOW'} OF ${s.ref ?? 'BTC'} ${s.date} → ${s.until}` : undefined,
    note: s.note,
    holdings: allocationSummary(s.allocations),
  }))
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
  result: {
    equity: EquityPoint[]
    benchmarks: { btc: EquityPoint[] }
    stats: { finalValue: number; maxDrawdownPct: number; vsBtcPct: number; twrPct?: number; netFlowUsd?: number }
  },
  initialCapitalUsd: number,
): string | null {
  const first = result.equity[0]
  const last = result.equity.at(-1)
  if (!first || !last || !(initialCapitalUsd > 0)) return null
  const day = (ts: number) => new Date(ts).toISOString().slice(0, 10)
  const days = Math.round((last.ts - first.ts) / 86_400_000)
  const ret = branchReturnPct(result, initialCapitalUsd)
  const flow = result.stats.netFlowUsd ?? 0
  const flowText = Math.abs(flow) >= 0.5 ? `, with ${usd0(Math.abs(flow))} net ${flow > 0 ? 'added' : 'withdrawn'} along the way` : ''
  const retText = Math.abs(flow) >= 0.5 ? 'time-weighted' : ''
  const btc = result.benchmarks.btc.at(-1)?.value
  const vs = result.stats.vsBtcPct
  const btcText = btc == null ? '' : ` Holding BTC over the same days${flowText ? ', with the same cash flows,' : ''} ended at ${usd0(btc)}: the branch ended ${Math.abs(vs) < 0.05 ? 'level with' : `${pct1(vs)} ${vs > 0 ? 'above' : 'below'}`} that.`
  return `${usd0(initialCapitalUsd)} on ${day(first.ts)} became ${usd0(result.stats.finalValue)} by ${day(last.ts)}${flowText} (${ret >= 0 ? '+' : '−'}${pct1(ret)}${retText ? ` ${retText}` : ''} over ${days} days). Deepest fall from a peak: ${pct1(result.stats.maxDrawdownPct)}.${btcText}`
}

/**
 * Return of a simulated branch in percent. Time-weighted when the engine reports it (it takes deposits and
 * withdrawals out); results cached before that field existed fall back to end value over starting capital.
 */
export function branchReturnPct(result: { stats: { finalValue: number; twrPct?: number } }, initialCapitalUsd: number): number {
  if (result.stats.twrPct != null) return result.stats.twrPct
  return initialCapitalUsd > 0 ? (result.stats.finalValue / initialCapitalUsd - 1) * 100 : 0
}

export interface MonthlyRow {
  year: number
  months: (number | null)[] // 12 slots, Jan..Dec, null when the year has no such month in the run
  totalPct: number // compounded over the months present
}

/** Calendar grid of monthly returns: one row per year, newest first. */
export function monthlyGrid(monthly: { month: string; returnPct: number }[]): MonthlyRow[] {
  const byYear = new Map<number, (number | null)[]>()
  for (const m of monthly) {
    const year = Number(m.month.slice(0, 4))
    const idx = Number(m.month.slice(5, 7)) - 1
    if (!byYear.has(year)) byYear.set(year, Array(12).fill(null))
    byYear.get(year)![idx] = m.returnPct
  }
  return [...byYear.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([year, months]) => ({
      year,
      months,
      totalPct: (months.reduce<number>((g, r) => (r == null ? g : g * (1 + r / 100)), 1) - 1) * 100,
    }))
}
