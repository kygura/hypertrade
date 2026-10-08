import { Fragment, type ReactNode } from 'react'
import { ddTone, fmtPct0, fmtPctSigned, fmtSigned, foldBars, foldCell, liveCell, signTone, type DsrN, type PerfStats, type RuleEvaluation } from '../../lib/lab'
import { DsrValue, SharpeValue } from './common'

// WindowStatsTable — DESIGN.md §10.9. All four windows at every width (rule
// 1), so it is the §4.4 escape hatch: .table-scroll with a sticky row-header
// column. SHARPE prints `untested` for a window with no trade. DSR and
// WF FOLDS (reported, never ranked on) belong to the walk-forward columns
// only. In the drill, the search-time (or save-time) walk-forward is its own
// column labelled AT SEARCH / AT SAVE left of today's (NOW): an explicit rule
// re-run today need not reproduce the search's walk-forward. Two benchmark
// rows follow (in-sample and holdout only).

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

/** Per-fold walk-forward Sharpes: a bar sparkline (decoration) beside the printed values (the signal); a null fold is `untested` and a gap. */
function FoldSharpes({ folds }: { folds: readonly (number | null)[] }) {
  const W = Math.max(12, folds.length * 8)
  const H = 14
  const { zeroY, bars } = foldBars(folds, W, H)
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap" title="Sharpe of each walk-forward test block, oldest first — reported, not ranked">
      <svg width={W} height={H} aria-hidden="true" className="flex-shrink-0">
        <line x1={0} x2={W} y1={zeroY} y2={zeroY} stroke="var(--color-border)" strokeWidth={1} />
        {bars.map((b) => (
          <rect key={b.i} x={b.x} y={b.y} width={b.width} height={b.height} fill={b.positive ? 'var(--color-green)' : 'var(--color-red)'} />
        ))}
      </svg>
      <span className="inline-flex gap-1.5">
        {folds.map((f, i) => {
          const c = foldCell(f)
          return (
            <span key={i} className={c.tone} title={c.title}>
              {c.text}
            </span>
          )
        })}
      </span>
      <span className="text-xs text-text-secondary">not ranked</span>
    </span>
  )
}

/** The search-time (or save-time) walk-forward, DSR and verdict, shown beside the fresh evaluation. */
export type AtSearch = { label: 'AT SEARCH' | 'AT SAVE'; ev: RuleEvaluation; dsrN: DsrN }

export function WindowStatsTable({
  ev,
  live,
  catalogued,
  benchmarkLabel,
  dsrN,
  wfSub,
  atSearch,
}: {
  /** The fresh evaluation, or the search-time one while it loads or when it failed (`wfSub` says which). */
  ev: RuleEvaluation
  live: PerfStats | null
  catalogued: boolean
  benchmarkLabel: string
  /** N context of `ev`'s deflated Sharpe. */
  dsrN: DsrN
  /** Sub-label of the walk-forward column: `NOW` for the fresh evaluation, else `AT SEARCH` / `AT SAVE`. */
  wfSub?: string
  /** Search-time walk-forward, as its own column left of today's. */
  atSearch?: AtSearch | null
}) {
  const lc = liveCell(live, catalogued)
  const at = atSearch ?? null
  const cols: Col[] = [
    { key: 'is', label: 'IN-SAMPLE', stats: ev.inSample },
    ...(at
      ? [
          {
            key: 'wf0',
            label: 'WALK-FWD',
            sub: at.label,
            stats: at.ev.walkForward,
            title: at.ev.walkForward ? `walk-forward ${at.label.toLowerCase()} — the rank key; today's walk-forward can differ` : 'not enough history',
          },
        ]
      : []),
    { key: 'wf', label: 'WALK-FWD', sub: wfSub, stats: ev.walkForward, title: ev.walkForward ? (wfSub === 'NOW' ? 're-run on current data' : 'walk-forward') : 'not enough history' },
    { key: 'ho', label: 'HOLDOUT', stats: ev.holdout, title: ev.holdout ? undefined : 'not enough history' },
    { key: 'live', label: 'LIVE', sub: lc.text && lc.text !== '—' ? lc.text : undefined, stats: lc.stats, title: lc.title },
  ]
  const bench: Record<string, PerfStats | null> = { is: ev.benchmark.inSample, ho: ev.benchmark.holdout }
  const dash = (title?: string) => (
    <span className="text-text-secondary" title={title}>
      —
    </span>
  )
  const showDsr = ev.deflatedSharpe !== undefined || (at != null && at.ev.deflatedSharpe !== undefined)
  const wfAt = cols.findIndex((c) => c.key === 'wf')
  const foldRow = (label: string, folds: readonly (number | null)[], from: number) => (
    <tr className="border-b border-border-subtle" style={{ height: 'var(--row-h)' }}>
      <th scope="row" className={ROW_TH}>
        {label}
      </th>
      {cols.slice(0, from).map((c) => (
        <td key={c.key} className="px-2 text-right">
          {dash()}
        </td>
      ))}
      <td colSpan={cols.length - from} className="px-2 text-left">
        <FoldSharpes folds={folds} />
      </td>
    </tr>
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
                  {showDsr && (
                    <tr className="border-b border-border-subtle" style={{ height: 'var(--row-h)' }}>
                      <th scope="row" className={ROW_TH}>
                        DSR
                      </th>
                      {cols.map((c) => (
                        <td key={c.key} className="px-2 text-right">
                          {c.key === 'wf' ? <DsrValue ev={ev} n={dsrN.n} assumedOne={dsrN.assumedOne} /> : c.key === 'wf0' && at ? <DsrValue ev={at.ev} n={at.dsrN.n} assumedOne={at.dsrN.assumedOne} /> : dash()}
                        </td>
                      ))}
                    </tr>
                  )}
                  {at && at.ev.walkForwardFolds && at.ev.walkForwardFolds.length > 0 && foldRow(`WF FOLDS ${at.label}`, at.ev.walkForwardFolds, 1)}
                  {ev.walkForwardFolds && ev.walkForwardFolds.length > 0 && foldRow(at ? 'WF FOLDS NOW' : 'WF FOLDS', ev.walkForwardFolds, wfAt)}
                </>
              )}
            </Fragment>
          ))}
          <tr className="border-b border-border-subtle" style={{ height: 'var(--row-h)' }}>
            <th scope="row" className={ROW_TH}>
              {benchmarkLabel} SHARPE
            </th>
            {cols.map((c) => {
              const b = bench[c.key]
              return (
                <td key={c.key} className="px-2 text-right">
                  {b ? <span className={signTone(b.sharpe)}>{fmtSigned(b.sharpe)}</span> : dash()}
                </td>
              )
            })}
          </tr>
          <tr style={{ height: 'var(--row-h)' }}>
            <th scope="row" className={ROW_TH}>
              {benchmarkLabel} RETURN
            </th>
            {cols.map((c) => {
              const b = bench[c.key]
              return (
                <td key={c.key} className="px-2 text-right">
                  {b ? <span className={signTone(b.totalReturn)}>{fmtPctSigned(b.totalReturn)}</span> : dash()}
                </td>
              )
            })}
          </tr>
        </tbody>
      </table>
    </div>
  )
}
