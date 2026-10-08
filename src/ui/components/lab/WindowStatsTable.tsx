import { Fragment, type ReactNode } from 'react'
import { ddTone, fmtPct0, fmtPctSigned, fmtSigned, foldBars, liveCell, signTone, type PerfStats, type RuleEvaluation } from '../../lib/lab'
import { DsrValue, SharpeValue } from './common'

// WindowStatsTable — DESIGN.md §10.9. All four windows at every width (rule
// 1), so it is the §4.4 escape hatch: .table-scroll with a sticky row-header
// column. SHARPE prints `untested` for a window with no trade. DSR and
// WF FOLDS (reported, never ranked on) belong to the walk-forward column
// only. Two benchmark rows follow (in-sample and holdout only).

type Col = { key: string; label: string; sub?: string; stats: PerfStats | null; title?: string }

const ROWS: Array<{ label: string; cell: (s: PerfStats) => ReactNode }> = [
  { label: 'TOTAL RETURN', cell: (s) => <span className={signTone(s.totalReturn)}>{fmtPctSigned(s.totalReturn)}</span> },
  { label: 'CAGR', cell: (s) => <span className={signTone(s.cagr)}>{fmtPctSigned(s.cagr)}</span> },
  { label: 'SHARPE', cell: (s) => <SharpeValue stats={s} /> },
  { label: 'MAX DD', cell: (s) => <span className={ddTone(s.maxDrawdown)}>{fmtPctSigned(s.maxDrawdown)}</span> },
  { label: 'HIT RATE', cell: (s) => fmtPct0(s.hitRate) },
  { label: 'TRADES', cell: (s) => s.trades },
  { label: 'TRADES/YR', cell: (s) => s.tradesPerYear.toFixed(1) },
  { label: 'EXPOSURE', cell: (s) => fmtPct0(s.exposure) },
  { label: 'DAYS', cell: (s) => s.days },
  {
    label: 'RANGE',
    cell: (s) => (
      <span className="text-xs whitespace-nowrap">
        {s.from} → {s.to}
      </span>
    ),
  },
]

const STICKY = 'sticky left-0 z-[1] bg-panel'
const ROW_TH = `${STICKY} px-2 text-left text-xs text-text-secondary font-normal whitespace-nowrap`

/** Per-fold walk-forward Sharpes: a bar sparkline (decoration) beside the printed values (the signal). */
function FoldSharpes({ folds }: { folds: readonly number[] }) {
  const W = Math.max(12, folds.length * 8)
  const H = 14
  const { zeroY, bars } = foldBars(folds, W, H)
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap" title="Sharpe of each walk-forward test block, oldest first — reported, not ranked">
      <svg width={W} height={H} aria-hidden="true" className="flex-shrink-0">
        <line x1={0} x2={W} y1={zeroY} y2={zeroY} stroke="var(--color-border)" strokeWidth={1} />
        {bars.map((b, i) => (
          <rect key={i} x={b.x} y={b.y} width={b.width} height={b.height} fill={b.positive ? 'var(--color-green)' : 'var(--color-red)'} />
        ))}
      </svg>
      <span className="inline-flex gap-1.5">
        {folds.map((f, i) => (
          <span key={i} className={signTone(f)}>
            {fmtSigned(f)}
          </span>
        ))}
      </span>
      <span className="text-xs text-text-secondary">not ranked</span>
    </span>
  )
}

export function WindowStatsTable({
  ev,
  live,
  catalogued,
  benchmarkLabel,
  trialsN,
}: {
  ev: RuleEvaluation
  live: PerfStats | null
  catalogued: boolean
  benchmarkLabel: string
  /** N of the deflated Sharpe when known. */
  trialsN?: number | null
}) {
  const lc = liveCell(live, catalogued)
  const cols: Col[] = [
    { key: 'is', label: 'IN-SAMPLE', stats: ev.inSample },
    { key: 'wf', label: 'WALK-FWD', sub: 'RANK KEY', stats: ev.walkForward, title: ev.walkForward ? 'walk-forward: thresholds refit per fold' : 'not enough history' },
    { key: 'ho', label: 'HOLDOUT', stats: ev.holdout, title: ev.holdout ? undefined : 'not enough history' },
    { key: 'live', label: 'LIVE', sub: lc.text && lc.text !== '—' ? lc.text : undefined, stats: lc.stats, title: lc.title },
  ]
  const bench = [ev.benchmark.inSample, null, ev.benchmark.holdout, null] as const
  const dash = (title?: string) => (
    <span className="text-text-secondary" title={title}>
      —
    </span>
  )

  return (
    <div className="table-scroll">
      <table className="w-full text-sm tabular border-collapse">
        <thead>
          <tr className="border-b border-border">
            <th scope="col" className={`${STICKY} px-2 py-1.5 text-left label`}>
              <span className="sr-only">metric</span>
            </th>
            {cols.map((c) => (
              <th key={c.key} scope="col" className="px-2 py-1.5 text-right label min-w-[72px] align-bottom" title={c.title}>
                {c.label}
                {c.sub && <span className="block text-xs text-text-secondary whitespace-nowrap">{c.sub}</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ROWS.map((r) => (
            <Fragment key={r.label}>
              <tr className="border-b border-border-subtle" style={{ height: 'var(--row-h)' }}>
                <th scope="row" className={ROW_TH}>
                  {r.label}
                </th>
                {cols.map((c) => (
                  <td key={c.key} className="px-2 text-right">
                    {c.stats ? r.cell(c.stats) : dash(c.title)}
                  </td>
                ))}
              </tr>
              {r.label === 'SHARPE' && (
                <>
                  {ev.deflatedSharpe !== undefined && (
                    <tr className="border-b border-border-subtle" style={{ height: 'var(--row-h)' }}>
                      <th scope="row" className={ROW_TH}>
                        DSR
                      </th>
                      {cols.map((c) => (
                        <td key={c.key} className="px-2 text-right">
                          {c.key === 'wf' ? <DsrValue dsr={ev.deflatedSharpe} n={trialsN} /> : dash()}
                        </td>
                      ))}
                    </tr>
                  )}
                  {ev.walkForwardFolds && ev.walkForwardFolds.length > 0 && (
                    <tr className="border-b border-border-subtle" style={{ height: 'var(--row-h)' }}>
                      <th scope="row" className={ROW_TH}>
                        WF FOLDS
                      </th>
                      <td className="px-2 text-right">{dash()}</td>
                      <td colSpan={3} className="px-2 text-left">
                        <FoldSharpes folds={ev.walkForwardFolds} />
                      </td>
                    </tr>
                  )}
                </>
              )}
            </Fragment>
          ))}
          <tr className="border-b border-border-subtle" style={{ height: 'var(--row-h)' }}>
            <th scope="row" className={ROW_TH}>
              {benchmarkLabel} SHARPE
            </th>
            {bench.map((b, i) => (
              <td key={i} className="px-2 text-right">
                {b ? <span className={signTone(b.sharpe)}>{fmtSigned(b.sharpe)}</span> : dash()}
              </td>
            ))}
          </tr>
          <tr style={{ height: 'var(--row-h)' }}>
            <th scope="row" className={ROW_TH}>
              {benchmarkLabel} RETURN
            </th>
            {bench.map((b, i) => (
              <td key={i} className="px-2 text-right">
                {b ? <span className={signTone(b.totalReturn)}>{fmtPctSigned(b.totalReturn)}</span> : dash()}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  )
}
