import { useMemo } from 'react'
import { CartesianGrid, ComposedChart, Line, ReferenceArea, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { logSafeEquity } from '../../lib/lab'
import { HowToRead, type Term } from '../HowToRead'

// Rule equity vs its benchmark — docs/design/README.md §10.9 (§9.1 variant). Growth
// multiple on a log Y axis (a 40× benchmark no longer flattens the rule;
// non-positive values become gaps); the holdout region (the one stretch the search
// never saw) is shaded `--color-info-bg` with a HOLDOUT label; catalogued
// rules get a dashed SAVED reference (the §9.1 TODAY idiom). Height per §4.5
// via the wrapper class (220 mobile / 300 lg).

export interface RuleEquityPoint {
  t: number
  strategy: number
  benchmark: number
}

const day = (t: number) => new Date(t).toISOString().slice(0, 10)
const month = (t: number) => new Date(t).toISOString().slice(0, 7)
const mult = (v: number) => `${v >= 10 ? v.toFixed(0) : Number(v.toPrecision(2))}×`
const multExact = (v: number | null) => (v == null ? '—' : `${v.toFixed(2)}×`)
const toMs = (d: string) => Date.parse(d.length === 10 ? `${d}T00:00:00Z` : d)

/** How to read the chart: both lines, the shaded stretch, the dashed line and the axes. The page renders it under the chart. */
export function RuleEquityGuide({ benchmarkLabel, saved, className }: { benchmarkLabel: string; saved: boolean; className?: string }) {
  const terms: Term[] = [
    ['RULE line', 'what 1 unit became following the rule: in the market on the day after its conditions were true, out otherwise, net of slippage. Flat stretches are days out of the market.'],
    [`${benchmarkLabel} line`, 'what 1 unit became simply holding the asset over the same days (holding it short, for a short rule).'],
    ['HOLDOUT shading', 'the most recent 20% of the history. It was set aside before any search, so the lines inside it are the part the rule was not chosen on.'],
    ...(saved ? ([['SAVED dashed line', 'the day the rule was saved. Everything to its right is the live record.']] as Term[]) : []),
    ['vertical axis · LOG', 'growth multiple: 2× is doubled, 0.5× is halved. The scale is logarithmic, so equal distances are equal percentage moves. A value at or below 0 is drawn as a gap.'],
    ['horizontal axis', 'date, labelled by month.'],
  ]
  return (
    <HowToRead terms={terms} className={className}>
      Growth of 1 unit following the rule against simply holding the asset, over the whole history. Look at whether the rule line keeps its course inside the shaded holdout, not at how
      high it ends. Past growth, not a forecast.
    </HowToRead>
  )
}

export function RuleEquityChart({
  equity,
  holdoutFrom,
  savedAt,
  benchmarkLabel,
}: {
  equity: RuleEquityPoint[]
  holdoutFrom: string
  savedAt?: string
  benchmarkLabel: string
}) {
  const data = useMemo(() => logSafeEquity(equity), [equity])
  const first = equity[0]?.t
  const last = equity[equity.length - 1]?.t
  const hoMs = toMs(holdoutFrom)
  const savedMs = savedAt ? toMs(savedAt) : NaN
  const showHoldout = first != null && last != null && Number.isFinite(hoMs) && hoMs < last
  const showSaved = first != null && last != null && Number.isFinite(savedMs) && savedMs >= first && savedMs <= last

  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs uppercase text-text-secondary mb-1.5">
        <span className="flex items-center gap-1">
          <span aria-hidden="true" className="inline-block w-2 h-2" style={{ background: 'var(--color-equity)' }} /> RULE
        </span>
        <span className="flex items-center gap-1">
          <span aria-hidden="true" className="inline-block w-2 h-2" style={{ background: 'var(--color-bench-btc)' }} /> {benchmarkLabel}
        </span>
        <span className="flex items-center gap-1">
          <span aria-hidden="true" className="inline-block w-2 h-2 bg-info-bg border border-info/40" /> HOLDOUT
        </span>
        {savedAt && (
          <span className="flex items-center gap-1">
            <span aria-hidden="true">┆</span> SAVED
          </span>
        )}
        <span className="ml-auto" title="growth multiple on a log scale">
          LOG
        </span>
      </div>
      <div className="h-[220px] lg:h-[300px]">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
            <CartesianGrid vertical={false} stroke="var(--color-border-subtle)" strokeDasharray="3 3" />
            <XAxis
              dataKey="t"
              type="number"
              domain={['dataMin', 'dataMax']}
              scale="time"
              tickFormatter={month}
              interval="preserveStartEnd"
              minTickGap={32}
              tick={{ fontSize: 11, fill: 'var(--color-text-secondary)' }}
              stroke="var(--color-border)"
            />
            <YAxis
              tickFormatter={mult}
              tick={{ fontSize: 11, fill: 'var(--color-text-secondary)' }}
              stroke="var(--color-border)"
              width={44}
              scale="log"
              domain={['auto', 'auto']}
              allowDataOverflow
            />
            <Tooltip
              labelFormatter={(t: number) => day(t)}
              formatter={(v: number, name: string) => [multExact(v), name === 'strategy' ? 'RULE' : benchmarkLabel]}
              contentStyle={{ background: 'var(--color-elevated)', border: '1px solid var(--color-border)', fontSize: 13 }}
            />
            {showHoldout && (
              <ReferenceArea
                x1={hoMs}
                x2={last}
                fill="var(--color-info-bg)"
                fillOpacity={1}
                stroke="none"
                ifOverflow="extendDomain"
                label={{ value: 'HOLDOUT', position: 'insideTopLeft', fontSize: 12, fill: 'var(--color-info)' }}
              />
            )}
            <Line dataKey="benchmark" stroke="var(--color-bench-btc)" strokeWidth={1} dot={false} isAnimationActive={false} />
            <Line dataKey="strategy" stroke="var(--color-equity)" strokeWidth={1.5} dot={false} isAnimationActive={false} />
            {showSaved && (
              <ReferenceLine
                x={savedMs}
                stroke="var(--color-text-secondary)"
                strokeDasharray="3 3"
                label={{ value: 'SAVED', position: 'insideTopRight', fontSize: 12, fill: 'var(--color-text-secondary)' }}
              />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}
