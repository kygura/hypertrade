import { Bar, BarChart, Cell, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { SimProjectionSummary, SimRolling } from '../../../shared/intent'
import { fmtPct, fmtUsd } from '../../../shared/format'
import { HowToRead, type Term } from '../HowToRead'
import { StatCell } from '../StatCell'
import { fmtChartDate, monthlyGrid, signClass } from './format'

// Result panels for /branches/:id beyond the equity curve: the same strategy from many past start
// dates, calendar-month returns, and the odds read off the forward projection. Engine side:
// src/server/sim/engine.ts (rollingWindows, monthlyReturns) and montecarlo.ts (summary).

const pct = (x: number, sign = true) => fmtPct(x / 100, { decimals: 1, sign })

const ROLLING_TERMS: readonly Term[] = [
  ['bar', 'one start date: the time-weighted return of the branch had it started that day and run for the window. Green above 0, red below.'],
  ['MEDIAN / P10 / P90', 'the middle start, and the start that did better than only 10% (or 90%) of the others.'],
  ['POSITIVE', 'share of start dates that ended the window above where they began.'],
  ['BEAT BTC', 'share of start dates where the branch ended above holding BTC over the same window.'],
  ['overlap', 'starts are a week or more apart but the windows overlap, so neighbouring bars share most of their days. They are not independent tries.'],
]

export function RollingPanel({ rolling }: { rolling: SimRolling }) {
  const s = rolling.summary
  return (
    <div className="flex flex-col gap-3">
      <HowToRead terms={ROLLING_TERMS}>
        The same recipe started on every {rolling.stepDays === 7 ? 'week' : `${rolling.stepDays}th day`} of the history and held {rolling.windowDays} days each. It separates
        a strategy that works from a lucky start date.
      </HowToRead>
      <div className="grid grid-cols-3 md:grid-cols-6 gap-3">
        <StatCell label="STARTS">{s.n}</StatCell>
        <StatCell label="MEDIAN" className={signClass(s.median)}>
          {pct(s.median)}
        </StatCell>
        <StatCell label="P10 / P90">
          <span className={signClass(s.p10)}>{pct(s.p10)}</span> / <span className={signClass(s.p90)}>{pct(s.p90)}</span>
        </StatCell>
        <StatCell label="WORST" className={signClass(s.worst)}>
          {pct(s.worst)}
        </StatCell>
        <StatCell label="POSITIVE">{pct(s.positivePct, false)}</StatCell>
        <StatCell label="BEAT BTC">{pct(s.beatBtcPct, false)}</StatCell>
      </div>
      <ResponsiveContainer width="100%" height={140}>
        <BarChart data={rolling.points} margin={{ top: 4, right: 8, left: 8, bottom: 4 }}>
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
            tickFormatter={(v: number) => `${v.toFixed(0)}%`}
            tick={{ fontSize: 12, fill: 'var(--color-text-secondary)' }}
            stroke="var(--color-border)"
            width={44}
          />
          <Tooltip
            labelFormatter={(ts: number) => `start ${new Date(ts).toISOString().slice(0, 10)}`}
            formatter={(v: number, key: string) => [pct(v), key === 'returnPct' ? 'return' : key]}
            contentStyle={{ background: 'var(--color-panel)', border: '1px solid var(--color-border)', fontSize: 13 }}
          />
          <ReferenceLine y={0} stroke="var(--color-border)" />
          <Bar dataKey="returnPct" isAnimationActive={false}>
            {rolling.points.map((p) => (
              <Cell key={p.ts} fill={p.returnPct >= 0 ? 'var(--color-green)' : 'var(--color-red)'} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

const MONTHS = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D']

export function MonthlyTable({ monthly }: { monthly: { month: string; returnPct: number }[] }) {
  const rows = monthlyGrid(monthly)
  return (
    <div className="table-scroll">
      <table className="w-full text-sm tabular min-w-max">
        <thead>
          <tr className="label">
            <th className="text-left font-normal pr-2">YEAR</th>
            {MONTHS.map((m, i) => (
              <th key={i} className="text-right font-normal px-1">
                {m}
              </th>
            ))}
            <th className="text-right font-normal pl-2">YEAR</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.year} className="border-t border-border-subtle">
              <td className="text-text-secondary pr-2 py-0.5">{r.year}</td>
              {r.months.map((v, i) => (
                <td key={i} className={`text-right px-1 ${v == null ? 'text-text-secondary' : signClass(v)}`}>
                  {v == null ? '·' : v.toFixed(1)}
                </td>
              ))}
              <td className={`text-right pl-2 ${signClass(r.totalPct)}`}>{pct(r.totalPct)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** The projection's end state in words and odds: what was put in, the spread, and the share of paths that lost, hit a target or ran dry. */
export function ProjectionOdds({ summary, horizonDays, targetUsd }: { summary: SimProjectionSummary; horizonDays: number; targetUsd?: number }) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3" title={`share of the simulated paths, at the end of the ${horizonDays}-day projection`}>
      <StatCell label="PUT IN BY THEN">{fmtUsd(summary.investedUsd, { decimals: 0 })}</StatCell>
      <StatCell label="MEDIAN END">{fmtUsd(summary.finalMedian, { decimals: 0 })}</StatCell>
      <StatCell label="ENDS BELOW PUT IN" className={summary.lossPct >= 50 ? 'text-red-text' : 'text-text-primary'}>
        {pct(summary.lossPct, false)}
      </StatCell>
      {summary.targetPct != null && targetUsd != null && (
        <StatCell label={`≥ ${fmtUsd(targetUsd, { decimals: 0 })}`}>{pct(summary.targetPct, false)}</StatCell>
      )}
      {summary.depletedPct != null && (
        <StatCell label="RAN OUT" className={summary.depletedPct > 0 ? 'text-red-text' : 'text-text-primary'}>
          {pct(summary.depletedPct, false)}
        </StatCell>
      )}
    </div>
  )
}
