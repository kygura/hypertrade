import type { ReactNode } from 'react'
import { Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { describeCondition, type LabRuleReport, type LabStats } from '../../../shared/lab'
import { Badge } from '../Badge'
import { fmtNum, STAT_ROWS, verdict } from './format'

// One rule report: conditions, verdict, the stats grid (holdout first — it is
// the only window the search never saw), and the equity curve vs holding.

function StatsGrid({ cols }: { cols: { label: string; stats: LabStats | null; title: string }[] }) {
  const shown = cols.filter((c) => c.stats)
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[10px] tabular">
        <thead>
          <tr className="text-text-secondary">
            <th className="text-left font-normal py-0.5 pr-2" />
            {shown.map((c) => (
              <th key={c.label} className="text-right font-normal py-0.5 pl-2 whitespace-nowrap" title={c.title}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {STAT_ROWS.map((row) => (
            <tr key={row.label} className="border-t border-border-subtle">
              <td className="text-text-secondary py-0.5 pr-2 whitespace-nowrap">{row.label}</td>
              {shown.map((c) => (
                <td key={c.label} className={`text-right py-0.5 pl-2 ${row.tone ? row.tone(c.stats!) : 'text-text-primary'}`}>
                  {row.get(c.stats!)}
                </td>
              ))}
            </tr>
          ))}
          <tr className="border-t border-border-subtle text-text-secondary">
            <td className="py-0.5 pr-2">WINDOW</td>
            {shown.map((c) => (
              <td key={c.label} className="text-right py-0.5 pl-2 whitespace-nowrap">
                {c.stats!.from.slice(2)}→{c.stats!.to.slice(2)}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  )
}

function benchmarkStats(s: LabStats | null): LabStats | null {
  if (!s) return null
  return { ...s, sharpe: s.benchmark.sharpe, totalReturnPct: s.benchmark.totalReturnPct, maxDrawdownPct: s.benchmark.maxDrawdownPct, cagrPct: NaN, exposure: 1, trades: NaN, winRate: null }
}

function EquityMini({ equity, splitAt, direction }: { equity: LabRuleReport['equity']; splitAt?: string; direction: string }) {
  const data = equity.map((p) => ({ t: Date.parse(p.ts), strategy: p.strategy, benchmark: p.benchmark }))
  if (data.length < 2) return null
  const split = splitAt ? Date.parse(splitAt) : undefined
  return (
    <div>
      <div className="flex items-center gap-3 text-[10px] text-text-secondary mb-1">
        <span className="flex items-center gap-1">
          <span style={{ color: 'var(--color-equity)' }}>—</span> RULE
        </span>
        <span className="flex items-center gap-1">
          <span style={{ color: 'var(--color-bench-btc)' }}>—</span> {direction === 'short' ? 'SHORT & HOLD' : 'HODL BTC'}
        </span>
        {split && <span>┆ HOLDOUT FROM {splitAt}</span>}
        <span className="ml-auto">LOG</span>
      </div>
      <div className="h-28">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 2, right: 4, left: 4, bottom: 2 }}>
            <XAxis dataKey="t" type="number" scale="time" domain={['dataMin', 'dataMax']} hide />
            <YAxis scale="log" domain={['auto', 'auto']} allowDataOverflow hide />
            <Tooltip
              labelFormatter={(t: number) => new Date(t).toISOString().slice(0, 10)}
              formatter={(v: number) => `${v.toFixed(2)}×`}
              contentStyle={{ background: 'var(--color-panel)', border: '1px solid var(--color-border)', fontSize: 11 }}
            />
            {split && <ReferenceLine x={split} stroke="var(--color-text-secondary)" strokeDasharray="2 3" />}
            <Line dataKey="benchmark" stroke="var(--color-bench-btc)" strokeWidth={1} dot={false} isAnimationActive={false} />
            <Line dataKey="strategy" stroke="var(--color-equity)" strokeWidth={1.5} dot={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

export function RuleCard({
  report,
  splitAt,
  actions,
  footer,
  firingNow = report.firingNow,
  asOf = report.asOf,
}: {
  report: LabRuleReport
  /** Holdout start, for the divider on the curve. */
  splitAt?: string
  actions?: ReactNode
  footer?: ReactNode
  firingNow?: boolean
  asOf?: string
}) {
  const v = verdict(report)
  const dir = report.rule.direction
  return (
    <article className="border border-border bg-panel p-3 flex flex-col gap-2.5 min-w-0">
      <header className="flex flex-wrap items-start gap-2">
        <Badge tone={dir === 'long' ? 'green' : 'red'}>{dir.toUpperCase()}</Badge>
        <div className="flex flex-col gap-0.5 min-w-0 flex-1 text-[11px] text-text-primary">
          {report.rule.conditions.map((c, i) => (
            <span key={i} className="break-words">
              {i > 0 && <span className="text-text-secondary">AND </span>}
              {describeCondition(c)}
              {c.q !== undefined && <span className="text-text-secondary"> · q{Math.round(c.q * 100)}</span>}
            </span>
          ))}
        </div>
        <div className="flex items-center gap-1.5">
          <span title={v.title}>
            <Badge tone={v.tone}>{v.label}</Badge>
          </span>
          <Badge tone={firingNow ? 'info' : 'gray'}>{firingNow ? 'FIRING' : 'IDLE'}</Badge>
        </div>
      </header>

      <StatsGrid
        cols={[
          { label: 'HOLDOUT', stats: report.outOfSample, title: 'Most recent 20%: never seen by the search' },
          { label: 'WALK-FWD', stats: report.walkForward, title: 'Out-of-fold returns, thresholds refit before each fold' },
          { label: 'IN-SAMPLE', stats: report.inSample, title: 'Train window with the final thresholds (optimistic)' },
          { label: 'B&H HOLD', stats: benchmarkStats(report.outOfSample), title: 'Holding over the holdout window' },
        ]}
      />

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-text-secondary tabular">
        <span title="Probability the walk-forward Sharpe beats the best of every variant tried, if all were noise. 0.95+ is the bar.">
          DEFLATED SHARPE <span className="text-text-primary">{fmtNum(report.deflatedSharpe)}</span>
        </span>
        <span title="Walk-forward Sharpe at neighbouring quantile thresholds, worst / own. Under 0.5 is fragile.">
          STABILITY <span className="text-text-primary">{fmtNum(report.stability)}</span>
        </span>
        <span>AS OF {asOf}</span>
      </div>

      <EquityMini equity={report.equity} splitAt={splitAt ?? report.outOfSample?.from} direction={dir} />

      {footer}
      {actions && <div className="flex flex-wrap justify-end gap-2">{actions}</div>}
    </article>
  )
}
