import { CartesianGrid, ComposedChart, Line, ReferenceArea, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'

// Rule equity vs its benchmark — DESIGN.md §10.9 (§9.1 variant). Growth
// multiple on the Y axis; the holdout region (the one stretch the search
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
const mult = (v: number) => `${v.toFixed(2)}×`
const toMs = (d: string) => Date.parse(d.length === 10 ? `${d}T00:00:00Z` : d)

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
      </div>
      <div className="h-[220px] lg:h-[300px]">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={equity} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
            <CartesianGrid vertical={false} stroke="var(--color-border-subtle)" strokeDasharray="3 3" />
            <XAxis
              dataKey="t"
              type="number"
              domain={['dataMin', 'dataMax']}
              scale="time"
              tickFormatter={month}
              interval="preserveStartEnd"
              minTickGap={32}
              tick={{ fontSize: 9, fill: 'var(--color-text-secondary)' }}
              stroke="var(--color-border)"
            />
            <YAxis
              tickFormatter={mult}
              tick={{ fontSize: 9, fill: 'var(--color-text-secondary)' }}
              stroke="var(--color-border)"
              width={44}
              domain={['auto', 'auto']}
            />
            <Tooltip
              labelFormatter={(t: number) => day(t)}
              formatter={(v: number, name: string) => [mult(v), name === 'strategy' ? 'RULE' : benchmarkLabel]}
              contentStyle={{ background: 'var(--color-elevated)', border: '1px solid var(--color-border)', fontSize: 11 }}
            />
            {showHoldout && (
              <ReferenceArea
                x1={hoMs}
                x2={last}
                fill="var(--color-info-bg)"
                fillOpacity={1}
                stroke="none"
                ifOverflow="extendDomain"
                label={{ value: 'HOLDOUT', position: 'insideTopLeft', fontSize: 10, fill: 'var(--color-info)' }}
              />
            )}
            <Line dataKey="benchmark" stroke="var(--color-bench-btc)" strokeWidth={1} dot={false} isAnimationActive={false} />
            <Line dataKey="strategy" stroke="var(--color-equity)" strokeWidth={1.5} dot={false} isAnimationActive={false} />
            {showSaved && (
              <ReferenceLine
                x={savedMs}
                stroke="var(--color-text-secondary)"
                strokeDasharray="3 3"
                label={{ value: 'SAVED', position: 'insideTopRight', fontSize: 10, fill: 'var(--color-text-secondary)' }}
              />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}
