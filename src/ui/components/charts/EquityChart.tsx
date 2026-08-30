import { Area, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { EquityPoint, MonteCarloResult } from '../branches/types'
import { fmtChartDate, fmtUsdCompact } from '../branches/format'
import { fmtUsd } from '../../../shared/format'
import { buildBandData, ProjectionReadout } from './FanChart'

// Equity curve vs benchmarks — DESIGN.md §9.1 (+ §9.3 forward fan on the
// same chart). One ComposedChart; each series carries its own `data` so
// history/benchmarks (dense) and projection (sparser, continues past
// history) don't need to be pre-merged into one array.

const LEGEND = [
  { glyph: '—', label: 'BRANCH', color: 'var(--color-equity)' },
  { glyph: '—', label: 'HODL BTC', color: 'var(--color-bench-btc)' },
  { glyph: '┄', label: 'USDC', color: 'var(--color-bench-usdc)' },
] as const

function tooltipFormatter(value: number) {
  return fmtUsd(value, { decimals: 0 })
}

export function EquityChart({
  equity,
  btc,
  usdc,
  projection,
  height = 300,
}: {
  equity: EquityPoint[]
  btc: EquityPoint[]
  usdc: EquityPoint[]
  projection?: MonteCarloResult
  height?: number
}) {
  const band = projection ? buildBandData(projection) : []
  const todayTs = band[0]?.ts

  return (
    <div>
      <div className="flex items-center gap-4 text-[10px] text-text-secondary mb-1.5">
        {LEGEND.map((l) => (
          <span key={l.label} className="flex items-center gap-1">
            <span style={{ color: l.color }}>{l.glyph}</span> {l.label}
          </span>
        ))}
      </div>
      <ResponsiveContainer width="100%" height={height}>
        <ComposedChart data={equity} margin={{ top: 4, right: 8, left: 8, bottom: 4 }}>
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
          <Tooltip
            labelFormatter={(ts: number) => fmtChartDate(ts)}
            formatter={tooltipFormatter}
            contentStyle={{
              background: 'var(--color-panel)',
              border: '1px solid var(--color-border)',
              fontSize: 11,
            }}
          />

          <Line dataKey="value" data={equity} stroke="var(--color-equity)" strokeWidth={1.5} dot={false} isAnimationActive={false} />
          <Line dataKey="value" data={btc} stroke="var(--color-bench-btc)" strokeWidth={1} dot={false} isAnimationActive={false} />
          <Line
            dataKey="value"
            data={usdc}
            stroke="var(--color-bench-usdc)"
            strokeWidth={1}
            strokeDasharray="4 3"
            dot={false}
            isAnimationActive={false}
          />

          {projection && (
            <>
              <Area dataKey="p10" data={band} stackId="band" stroke="none" fill="transparent" isAnimationActive={false} />
              <Area
                dataKey="bandHeight"
                data={band}
                stackId="band"
                stroke="none"
                fill="var(--color-proj-band)"
                isAnimationActive={false}
              />
              <Line
                dataKey="median"
                data={band}
                stroke="var(--color-proj-line)"
                strokeWidth={1.5}
                strokeDasharray="6 3"
                dot={false}
                isAnimationActive={false}
              />
            </>
          )}

          {todayTs != null && (
            <ReferenceLine
              x={todayTs}
              stroke="var(--color-text-secondary)"
              strokeDasharray="1 3"
              label={{ value: 'TODAY', position: 'insideTopRight', fontSize: 10, fill: 'var(--color-text-secondary)' }}
            />
          )}
        </ComposedChart>
      </ResponsiveContainer>
      {projection && (
        <div className="mt-1">
          <ProjectionReadout projection={projection} />
        </div>
      )}
    </div>
  )
}
