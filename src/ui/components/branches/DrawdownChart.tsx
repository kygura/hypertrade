import { Area, AreaChart, ReferenceDot, ResponsiveContainer, XAxis, YAxis } from 'recharts'
import type { EquityPoint } from './types'
import { computeDrawdown, fmtChartDate } from './format'

// Drawdown panel chart — DESIGN.md §9.2. Values <= 0, 0 sits naturally at
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
          tick={{ fontSize: 10, fill: 'var(--color-text-secondary)' }}
          stroke="var(--color-border)"
        />
        <YAxis
          domain={['dataMin', 0]}
          tickFormatter={(v: number) => `${v.toFixed(0)}%`}
          tick={{ fontSize: 10, fill: 'var(--color-text-secondary)' }}
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
          r={4}
          shape={(props: { cx?: number; cy?: number }) => (
            <rect x={(props.cx ?? 0) - 2} y={(props.cy ?? 0) - 2} width={4} height={4} fill="var(--color-drawdown-line)" />
          )}
        />
      </AreaChart>
    </ResponsiveContainer>
  )
}
