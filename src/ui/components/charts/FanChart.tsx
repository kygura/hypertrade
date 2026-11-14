import type { BranchConfig } from '../../../shared/types'
import type { MonteCarloResult } from '../branches/types'
import { fmtUsdCompact } from '../branches/format'

// Monte-carlo fan — docs/design/README.md §9.3. `buildBandData` is the data prep for the
// band+median recipe EquityChart draws inline on its own combined chart.

export interface FanPoint {
  ts: number
  p10: number
  bandHeight: number // p90 - p10, stacked on top of p10 to draw the range
  median: number
}

export function buildBandData(projection: MonteCarloResult): FanPoint[] {
  return projection.median.map((m, i) => ({
    ts: m.ts,
    p10: projection.p10[i]?.value ?? m.value,
    bandHeight: (projection.p90[i]?.value ?? m.value) - (projection.p10[i]?.value ?? m.value),
    median: m.value,
  }))
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
export function ProjectionAssumptions({ scenario }: { scenario: NonNullable<BranchConfig['scenario']> }) {
  const parts = scenario.assumptions.map(
    (a) => `${a.coin} ${a.annualReturnPct >= 0 ? '+' : ''}${a.annualReturnPct}%/${a.annualVolPct}% VOL`,
  )
  return (
    <div
      className="text-xs text-text-secondary"
      title="the assumptions behind the fan: days projected, number of random paths, and per coin the yearly return and volatility you entered. GBM = each path is a random walk with that drift and volatility; coins are treated as uncorrelated. An illustration, not a forecast"
    >
      PROJECTION {scenario.horizonDays}D · {scenario.paths} PATHS · {parts.join(' · ')} · GBM
    </div>
  )
}
