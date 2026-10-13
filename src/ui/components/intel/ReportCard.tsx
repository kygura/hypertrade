import type { JournalReport, ReportFinding } from '../../../shared/intel'
import { Button } from '../Button'
import { Panel, PanelHeader } from '../Panel'
import { EmptyBlock, ErrorBlock, OfflineBlock, SkeletonRows } from '../state'
import { ClaimAge } from './ClaimAge'
import { ClaimLine } from './ClaimLine'
import { ClaimList } from './ClaimList'
import { fmtR, fmtUsdSigned2, signClass } from './format'
import { TradeIdLinks } from './TradeIdLinks'

// ReportCard — DESIGN-terminal §4.2. `WEEKLY REPORT · WEEK OF <date>` +
// ClaimAge (amber > 7 d). LEAKS (top 3) and EDGES (top 2): the computed
// finding as plain values, the model's line as a ClaimLine, then the trade
// ids behind it. A narration failure stored on the report (LLM failure, cap,
// not configured) shows verbatim; the numbers still stand.

export const REPORT_STALE_H = 168

export function weekOf(report: Pick<JournalReport, 'createdAt' | 'periodDays'>): string {
  const t = Date.parse(report.createdAt) - report.periodDays * 86_400_000
  return Number.isNaN(t) ? '—' : new Date(t).toISOString().slice(0, 10)
}

function Finding({ f, onPickTrade }: { f: ReportFinding; onPickTrade: (id: string) => void }) {
  return (
    <li className="flex flex-col gap-1">
      <span className="text-[11px] tabular text-text-primary">
        {f.tag} · {f.trades} {f.trades === 1 ? 'trade' : 'trades'} · EXP{' '}
        {f.expectancyR != null ? (
          <span className={signClass(f.expectancyR)}>{fmtR(f.expectancyR, 2)}</span>
        ) : (
          <span className={signClass(f.expectancyUsd)}>{fmtUsdSigned2(f.expectancyUsd)}</span>
        )}
      </span>
      {f.line && <ClaimLine claim={f.line} />}
      <TradeIdLinks ids={f.tradeIds} onPick={onPickTrade} />
    </li>
  )
}

function Section({ label, findings, onPickTrade }: { label: string; findings: ReportFinding[]; onPickTrade: (id: string) => void }) {
  if (findings.length === 0) return null
  return (
    <section className="flex flex-col gap-2">
      <h3 className="label">{label}</h3>
      <ol className="flex flex-col gap-3">
        {findings.map((f) => (
          <Finding key={f.tag} f={f} onPickTrade={onPickTrade} />
        ))}
      </ol>
    </section>
  )
}

export function ReportCard({
  report,
  loading = false,
  loadError,
  offline,
  onRetry,
  onGenerate,
  generating = false,
  generateError,
  onPickTrade,
}: {
  report: JournalReport | null
  loading?: boolean
  loadError?: string | null
  offline?: string | null
  onRetry?: () => void
  onGenerate: () => void
  generating?: boolean
  generateError?: string | null
  onPickTrade: (id: string) => void
}) {
  const title = report ? `WEEKLY REPORT · WEEK OF ${weekOf(report)}` : 'WEEKLY REPORT'
  const generateBtn = (
    <Button tier="neutral" onClick={onGenerate} disabled={generating}>
      <span className={generating ? 'pulse-label' : undefined}>{generating ? 'GENERATING…' : 'GENERATE REPORT'}</span>
    </Button>
  )

  let body
  if (loading && !report) body = <SkeletonRows />
  else if (offline && !report) body = <OfflineBlock onRetry={onRetry} />
  else if (loadError && !report) body = <ErrorBlock message={loadError} onRetry={onRetry} />
  else if (!report)
    body = generating ? <SkeletonRows /> : <EmptyBlock label="no report yet" action={{ label: 'GENERATE REPORT', onClick: onGenerate }} />
  else {
    const empty = report.leaks.length === 0 && report.edges.length === 0 && report.lines.length === 0
    body = (
      <div className={`flex flex-col gap-4 p-3 ${generating ? 'opacity-70' : ''}`}>
        {report.trace?.error && <ErrorBlock message={report.trace.error} onRetry={onGenerate} />}
        {empty && <p className="text-[11px] text-text-secondary">no closed trades in the {report.periodDays}-day period</p>}
        <Section label="LEAKS" findings={report.leaks.slice(0, 3)} onPickTrade={onPickTrade} />
        <Section label="EDGES" findings={report.edges.slice(0, 2)} onPickTrade={onPickTrade} />
        {(report.lines.length > 0 || (report.trace?.dropped ?? 0) > 0) && <ClaimList claims={report.lines} dropped={report.trace?.dropped} />}
        <div>{generateBtn}</div>
      </div>
    )
  }

  return (
    <Panel>
      <PanelHeader title={title}>{report && <ClaimAge ts={report.createdAt} thresholdHours={REPORT_STALE_H} prefix="GEN" />}</PanelHeader>
      {generateError && <ErrorBlock message={generateError} onRetry={onGenerate} />}
      {body}
      <p className="px-3 py-2 border-t border-border-subtle text-[10px] text-text-secondary">historical record, not advice</p>
    </Panel>
  )
}
