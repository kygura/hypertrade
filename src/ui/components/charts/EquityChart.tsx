import { Area, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { EquityPoint, MonteCarloResult } from '../branches/types'
import { fmtChartDate, fmtUsdCompact } from '../branches/format'
import { fmtUsd } from '../../../shared/format'
import { buildBandData, ProjectionReadout } from './FanChart'
import { HowToRead, type Term } from '../HowToRead'

// Equity curve vs benchmarks — docs/design/README.md §9.1 (+ §9.3 forward fan on the
// same chart). One ComposedChart; each series carries its own `data` so
// history/benchmarks (dense) and projection (sparser, continues past
// history) don't need to be pre-merged into one array.

const LEGEND = [
  { glyph: '—', label: 'BRANCH', color: 'var(--color-equity)' },
  { glyph: '—', label: 'HODL BTC', color: 'var(--color-bench-btc)' },
  { glyph: '┄', label: 'USDC', color: 'var(--color-bench-usdc)' },
] as const

const EQUITY_TERMS: readonly Term[] = [
  ['BRANCH line', 'the simulated value of the portfolio in USD on each daily close, with its rebalance and DCA rules applied.'],
  ['HODL BTC line', 'the same starting capital put into BTC on the start date and left alone.'],
  ['USDC dashed line', 'the same starting capital left in USDC.'],
  ['vertical axis', 'value in USD.'],
  ['horizontal axis', 'date, as month/day.'],
]
const PROJECTION_TERMS: readonly Term[] = [
  ['TODAY dotted line', 'where the history ends and the projection starts.'],
  ['shaded band', 'the middle 80% of the simulated paths: on each day, from the 10th to the 90th percentile.'],
  ['dashed line in the band', 'the median path: half the simulated paths are above it, half below.'],
  ['P90 / P50 / P10', 'the value at the end of the projection at the 90th percentile, the median and the 10th percentile of the paths.'],
]

/** How to read the equity chart; `projection` adds the fan's encoding. The page renders it under the chart. */
export function EquityGuide({ projection, className }: { projection: boolean; className?: string }) {
  return (
    <HowToRead terms={projection ? [...EQUITY_TERMS, ...PROJECTION_TERMS] : EQUITY_TERMS} className={className}>
      The branch's simulated value over time against two yardsticks: the same capital held in BTC, and left in USDC. Everything up to today is replayed history on daily closes.
      {projection ? ' The fan after TODAY is a spread of random paths drawn from the return and volatility you typed in: an illustration of those assumptions, not a forecast.' : ''}
    </HowToRead>
  )
}

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
      <div className="flex items-center gap-4 text-xs text-text-secondary mb-1.5">
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
            tick={{ fontSize: 12, fill: 'var(--color-text-secondary)' }}
            stroke="var(--color-border)"
          />
          <YAxis
            tickFormatter={fmtUsdCompact}
            tick={{ fontSize: 12, fill: 'var(--color-text-secondary)' }}
            stroke="var(--color-border)"
            width={48}
          />
          <Tooltip
            labelFormatter={(ts: number) => fmtChartDate(ts)}
            formatter={tooltipFormatter}
            contentStyle={{
              background: 'var(--color-panel)',
              border: '1px solid var(--color-border)',
              fontSize: 13,
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
              label={{ value: 'TODAY', position: 'insideTopRight', fontSize: 12, fill: 'var(--color-text-secondary)' }}
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
