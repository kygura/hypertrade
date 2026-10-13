import type { ThesisCheck, ThesisClaim, ThesisEvidence } from '../../../shared/intel'
import { Badge, type Tone } from '../Badge'
import { ClaimAge } from './ClaimAge'
import { fmtLevel, fmtOp, fmtSigned } from './format'
import { SourceLink } from './SourceLink'

// CheckRow — DESIGN-terminal §5.2. One extracted claim/assumption: status
// Badge (a word, never color alone), kind word, the operator's own words, the
// check typeset in our language, then the evidence code found (value ·
// SourceLink · ClaimAge). Unknown with no data → `no data`.

export type CheckStatus = ThesisClaim['status']

export const STATUS_TONE: Record<CheckStatus, Tone> = { supported: 'green', contradicted: 'red', unknown: 'gray' }
export const STATUS_ORDER: Record<CheckStatus, number> = { contradicted: 0, unknown: 1, supported: 2 }

/** Contradicted first, then unknown, then supported; stable within a status. */
export function sortChecks<T extends { status: CheckStatus }>(claims: T[]): T[] {
  return claims.map((c, i) => [c, i] as const).sort((a, b) => STATUS_ORDER[a[0].status] - STATUS_ORDER[b[0].status] || a[1] - b[1]).map(([c]) => c)
}

export function StatusBadge({ status }: { status: CheckStatus }) {
  return <Badge tone={STATUS_TONE[status]}>{status.toUpperCase()}</Badge>
}

/** The check in our language: `HYPE price < $79.2K`, `HYPE OI change 24h > +5%`. */
export function fmtCheck(c: ThesisCheck): string {
  switch (c.kind) {
    case 'metric_threshold':
      return `metric ${c.series} ${fmtOp(c.op)} ${c.value}`
    case 'price_vs_level':
      return `${c.asset} price ${fmtOp(c.op)} ${fmtLevel(c.level)}`
    case 'funding_sign':
      return `${c.asset} funding ${c.sign}`
    case 'oi_change':
      return `${c.asset} OI change ${c.window_h}h ${fmtOp(c.op)} ${fmtSigned(c.pct, Number.isInteger(c.pct) ? 0 : 1, '%')}`
    case 'event_exists':
      return `event since ${c.since_h}h: "${c.query}"`
    case 'unknown':
      return 'no automatic check'
  }
}

/** The evidence value in the check's own unit. */
export function fmtEvidenceValue(c: ThesisCheck, v: ThesisEvidence['value']): string {
  if (v == null) return 'no data'
  if (typeof v === 'string') return v
  switch (c.kind) {
    case 'price_vs_level':
      return fmtLevel(v)
    case 'oi_change':
      return fmtSigned(v, 1, '%')
    case 'funding_sign':
      return `${v > 0 ? '+' : v < 0 ? '−' : ''}${(Math.abs(v) * 100).toFixed(4)}%/h`
    default:
      return String(v)
  }
}

export function Evidence({ check, evidence }: { check: ThesisCheck; evidence?: ThesisEvidence }) {
  if (!evidence) return <span className="text-[11px] text-text-secondary">no data</span>
  return (
    <span className="inline-flex flex-wrap items-center gap-1 text-[11px]">
      <span className="text-text-primary tabular">now {fmtEvidenceValue(check, evidence.value)}</span>
      <span aria-hidden="true" className="text-[10px] text-text-secondary">
        ·
      </span>
      <SourceLink source={evidence.source} />
      <span aria-hidden="true" className="text-[10px] text-text-secondary">
        ·
      </span>
      <ClaimAge ts={evidence.ts} />
    </span>
  )
}

export function CheckRow({ check }: { check: ThesisClaim }) {
  const reason = check.check.kind === 'unknown' ? check.check.reason : undefined
  return (
    <li className="flex flex-col gap-1 py-2 border-b border-border-subtle last:border-b-0" data-status={check.status}>
      <div className="flex flex-wrap items-baseline gap-2">
        <StatusBadge status={check.status} />
        <span className="text-[10px] uppercase tracking-wider text-text-secondary">{check.kind === 'claim' ? 'CLAIM' : 'ASSUMPTION'}</span>
        <span className="text-[12px] text-text-primary min-w-0 break-words">{check.text}</span>
      </div>
      <div className="pl-1 flex flex-col gap-0.5">
        <span className="text-[11px] text-text-muted" title={reason}>
          <span className="text-text-secondary">check:</span> {fmtCheck(check.check)}
        </span>
        <Evidence check={check.check} evidence={check.evidence} />
      </div>
    </li>
  )
}
