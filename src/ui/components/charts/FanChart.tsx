import type { BranchConfig } from '../../../shared/types'
import type { EquityPoint, MonteCarloResult } from '../branches/types'
import { fmtUsdCompact } from '../branches/format'

// Monte-carlo fan — docs/design/README.md §9.3. `buildChartRows` is the data prep for the
// combined history + fan chart EquityChart draws.

export interface ChartRow {
  ts: number
  value?: number // branch equity
  btc?: number
  usdc?: number
  band?: [number, number] // p10..p90
  inner?: [number, number] // p25..p75, absent on results cached before it existed
  median?: number
}

/**
 * One array for the whole chart, keyed by day. Recharts computes the x domain and any stacking from
 * a single data set, so series with their own `data` drew no fan and cut the axis at the last
 * history day; ranged areas ([low, high] per row) need no stacking at all.
 */
export function buildChartRows(
  equity: EquityPoint[],
  btc: EquityPoint[],
  usdc: EquityPoint[],
  projection?: MonteCarloResult,
): ChartRow[] {
  const rows = new Map<number, ChartRow>()
  const row = (ts: number) => {
    let r = rows.get(ts)
    if (!r) rows.set(ts, (r = { ts }))
    return r
  }
  for (const p of equity) row(p.ts).value = p.value
  for (const p of btc) row(p.ts).btc = p.value
  for (const p of usdc) row(p.ts).usdc = p.value
  projection?.median.forEach((m, i) => {
    const r = row(m.ts)
    r.median = m.value
    r.band = [projection.p10[i]?.value ?? m.value, projection.p90[i]?.value ?? m.value]
    const p25 = projection.p25?.[i]?.value
    const p75 = projection.p75?.[i]?.value
    if (p25 != null && p75 != null) r.inner = [p25, p75]
  })
  return [...rows.values()].sort((a, b) => a.ts - b.ts)
}

// Terminal readout — plain text, not chart labels (docs/design/README.md §9.3).
export function ProjectionReadout({ projection }: { projection: MonteCarloResult }) {
  const p10 = projection.p10.at(-1)?.value
  const p50 = projection.median.at(-1)?.value
  const p90 = projection.p90.at(-1)?.value
  if (p10 == null || p50 == null || p90 == null) return null
  return (
    <div className="text-sm text-info text-right tabular" title="value at the end of the projection: 90th percentile, median and 10th percentile of the simulated paths">
      P90 {fmtUsdCompact(p90)} / P50 {fmtUsdCompact(p50)} / P10 {fmtUsdCompact(p10)}
    </div>
  )
}

// Assumptions line — always visible when a fan is drawn (docs/design/README.md
// principle 6 + §10.4): a projection without visible assumptions is forbidden.
export function ProjectionAssumptions({
  scenario,
  cashflow,
}: {
  scenario: NonNullable<BranchConfig['scenario']>
  cashflow?: BranchConfig['cashflow']
}) {
  const flow = cashflow
    ? ` · ${cashflow.amountUsd > 0 ? '+' : '−'}${fmtUsdCompact(Math.abs(cashflow.amountUsd))} ${cashflow.every === 'weekly' ? 'WEEKLY' : 'MONTHLY'}`
    : ''
  const target = scenario.targetUsd ? ` · TARGET ${fmtUsdCompact(scenario.targetUsd)}` : ''
  if (scenario.method === 'bootstrap') {
    return (
      <div
        className="text-xs text-text-secondary"
        title="the assumptions behind the fan: days projected, number of random paths, and how they are drawn. HISTORY = each path strings together random blocks of consecutive days from this branch's own simulated daily returns, fees and funding included. It can only replay what that history contains. An illustration, not a forecast"
      >
        PROJECTION {scenario.horizonDays}D · {scenario.paths} PATHS · HISTORY, {scenario.blockDays ?? 10}-DAY BLOCKS{flow}
        {target}
      </div>
    )
  }
  const parts = scenario.assumptions.map(
    (a) => `${a.coin} ${a.annualReturnPct >= 0 ? '+' : ''}${a.annualReturnPct}%/${a.annualVolPct}% VOL`,
  )
  return (
    <div
      className="text-xs text-text-secondary"
      title="the assumptions behind the fan: days projected, number of random paths, and per coin the yearly return and volatility you entered. GBM = each path is a random walk with that drift and volatility; coins are treated as uncorrelated. An illustration, not a forecast"
    >
      PROJECTION {scenario.horizonDays}D · {scenario.paths} PATHS · {parts.join(' · ')} · GBM{flow}
      {target}
    </div>
  )
}
