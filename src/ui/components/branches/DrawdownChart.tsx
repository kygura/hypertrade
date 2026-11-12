import { Area, AreaChart, ReferenceDot, ResponsiveContainer, XAxis, YAxis } from 'recharts'
import type { EquityPoint } from './types'
import { computeDrawdown, fmtChartDate } from './format'
import { HowToRead, type Term } from '../HowToRead'

const DRAWDOWN_TERMS: readonly Term[] = [
  ['shaded area', 'the fall from the highest value reached so far, on each day. A wide area is a long stretch below the old high.'],
  ['square', 'the deepest point: the max drawdown printed in the header.'],
  ['vertical axis', 'percent below the running high. 0% at the top means a new high.'],
  ['horizontal axis', 'date, as month/day.'],
]

/** How to read the drawdown chart. The page renders it under the chart. */
export function DrawdownGuide({ className }: { className?: string }) {
  return (
    <HowToRead terms={DRAWDOWN_TERMS} className={className}>
      How far the value sits below its own highest point so far. It shows the losses you would have had to sit through: how deep they went and how long they lasted.
    </HowToRead>
  )
}

// Drawdown panel chart — docs/design/README.md §9.2. Values <= 0, 0 sits naturally at
// the top since it's the greatest value on the axis. Worst point gets a
// small square ReferenceDot; the header's "MAX DD −x%" line is drawn by
// the caller from the branch's own stats.maxDrawdownPct, not recomputed here.

export function DrawdownChart({ equity, height = 120 }: { equity: EquityPoint[]; height?: number }) {
  const data = computeDrawdown(equity)
  if (data.length === 0) return null

  let worst = 0
  for (let i = 1; i < data.length; i++) if (data[i]!.value < data[worst]!.value) worst = i

  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 4, right: 8, left: 8, bottom: 4 }}>
        <XAxis
          dataKey="ts"
          type="number"
          domain={['dataMin', 'dataMax']}
          scale="time"
          tickFormatter={fmtChartDate}
          tick={{ fontSize: 12, fill: 'var(--color-text-secondary)' }}
          stroke="var(--color-border)"
        />
        <YAxis
          domain={['dataMin', 0]}
          tickFormatter={(v: number) => `${v.toFixed(0)}%`}
          tick={{ fontSize: 12, fill: 'var(--color-text-secondary)' }}
          stroke="var(--color-border)"
          width={40}
        />
        <Area
          dataKey="value"
          stroke="var(--color-drawdown-line)"
          strokeWidth={1}
          fill="var(--color-drawdown-fill)"
          dot={false}
          isAnimationActive={false}
        />
        <ReferenceDot
          x={data[worst]!.ts}
          y={data[worst]!.value}
          r={2}
          shape={(props: { cx?: number; cy?: number }) => (
            <rect x={(props.cx ?? 0) - 1} y={(props.cy ?? 0) - 1} width={2} height={2} fill="var(--color-drawdown-line)" />
          )}
        />
      </AreaChart>
    </ResponsiveContainer>
  )
}
