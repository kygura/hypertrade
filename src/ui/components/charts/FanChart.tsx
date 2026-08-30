import { Area, CartesianGrid, ComposedChart, Line, ResponsiveContainer, XAxis, YAxis } from 'recharts'
import type { BranchConfig } from '../../../shared/types'
import type { MonteCarloResult } from '../branches/types'
import { fmtChartDate, fmtUsdCompact } from '../branches/format'

// Monte-carlo fan — DESIGN.md §9.3. `buildBandData` is the shared merge used
// both by the standalone chart below and by EquityChart, which draws the
// same band+median recipe inline on its own combined chart (recharts can't
// reliably compose a nested chart's <Area>/<Line> into a parent chart, so
// the two chart components share the data prep, not JSX).

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

// Standalone fan chart — same visual recipe as EquityChart's forward
// section, usable on its own (e.g. a future projection-only surface).
export function FanChart({ projection, height = 220 }: { projection: MonteCarloResult; height?: number }) {
  const data = buildBandData(projection)
  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={data} margin={{ top: 4, right: 8, left: 8, bottom: 4 }}>
        <CartesianGrid stroke="var(--color-border-subtle)" vertical={false} />
        <XAxis
          dataKey="ts"
          type="number"
          domain={['dataMin', 'dataMax']}
          scale="time"
          tickFormatter={fmtChartDate}
          tick={{ fontSize: 10, fill: 'var(--color-text-secondary)' }}
          stroke="var(--color-border)"
        />
        <YAxis
          tickFormatter={fmtUsdCompact}
          tick={{ fontSize: 10, fill: 'var(--color-text-secondary)' }}
          stroke="var(--color-border)"
          width={48}
        />
        <Area
          dataKey="p10"
          stackId="band"
          stroke="none"
          fill="transparent"
          isAnimationActive={false}
        />
        <Area
          dataKey="bandHeight"
          stackId="band"
          stroke="none"
          fill="var(--color-proj-band)"
          isAnimationActive={false}
        />
        <Line
          dataKey="median"
          stroke="var(--color-proj-line)"
          strokeWidth={1.5}
          strokeDasharray="6 3"
          dot={false}
          isAnimationActive={false}
        />
      </ComposedChart>
    </ResponsiveContainer>
  )
}

// Terminal readout — plain text, not chart labels (DESIGN.md §9.3).
export function ProjectionReadout({ projection }: { projection: MonteCarloResult }) {
  const p10 = projection.p10.at(-1)?.value
  const p50 = projection.median.at(-1)?.value
  const p90 = projection.p90.at(-1)?.value
  if (p10 == null || p50 == null || p90 == null) return null
  return (
    <div className="text-[11px] text-info text-right tabular">
      P90 {fmtUsdCompact(p90)} / P50 {fmtUsdCompact(p50)} / P10 {fmtUsdCompact(p10)}
    </div>
  )
}

// Assumptions line — always visible when a fan is drawn (DESIGN.md
// principle 6 + §10.4): a projection without visible assumptions is forbidden.
export function ProjectionAssumptions({ scenario }: { scenario: NonNullable<BranchConfig['scenario']> }) {
  const parts = scenario.assumptions.map(
    (a) => `${a.coin} ${a.annualReturnPct >= 0 ? '+' : ''}${a.annualReturnPct}%/${a.annualVolPct}% VOL`,
  )
  return (
    <div className="text-[10px] text-text-secondary">
      PROJECTION {scenario.horizonDays}D · {scenario.paths} PATHS · {parts.join(' · ')} · GBM
    </div>
  )
}
