import { Button } from '../Button'
import type { Intent, Verdict } from '../../../shared/strategy-protocol'
import { VerdictBadge } from './VerdictBadge'
import { ACTION_LABEL, actionClass, fmtProb, fmtTsSec, fmtUsdSigned } from './format'

// IntentRow — one intent with its verdict timeline beneath. Approve/reject
// buttons appear only while the latest verdict is `proposed` and the record
// is not a dry run (dry runs never reach the governor). The buttons open the
// caller's confirm dialog (DESIGN.md §7 Level 2) — they never act directly.

export function latestVerdict(verdicts: Verdict[], intentId: string): Verdict | null {
  const mine = verdicts.filter((v) => v.intent_id === intentId).sort((a, b) => a.ts.localeCompare(b.ts))
  return mine[mine.length - 1] ?? null
}

export function IntentRow({
  intent,
  verdicts,
  dryRun,
  busy = false,
  onApprove,
  onReject,
}: {
  intent: Intent
  verdicts: Verdict[]
  dryRun: boolean
  busy?: boolean
  onApprove?: (intent: Intent) => void
  onReject?: (intent: Intent) => void
}) {
  const timeline = verdicts.filter((v) => v.intent_id === intent.id).sort((a, b) => a.ts.localeCompare(b.ts))
  const latest = timeline[timeline.length - 1] ?? null
  const actionable = !dryRun && latest?.status === 'proposed' && (onApprove || onReject)

  return (
    <div className="flex flex-col gap-2 py-2 border-b border-border-subtle last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
        <span className="text-text-primary font-medium">{intent.market}</span>
        <span className={`uppercase tracking-wider ${actionClass(intent.action)}`}>{ACTION_LABEL[intent.action]}</span>
        {intent.size_usd != null && <span className="tabular text-text-primary">${intent.size_usd.toLocaleString()}</span>}
        {intent.target_weight != null && (
          <span className="tabular text-text-muted">W {(intent.target_weight * 100).toFixed(1)}%</span>
        )}
        {intent.price_limit != null && <span className="tabular text-text-muted">LIM {intent.price_limit}</span>}
        {intent.confidence != null && <span className="tabular text-text-secondary">CONF {fmtProb(intent.confidence)}</span>}
        <span className="text-text-secondary">{intent.venue}</span>
        <span className="ml-auto flex items-center gap-2">
          {dryRun && <span className="text-[10px] uppercase tracking-wider text-text-secondary">dry run · not governed</span>}
          {latest ? (
            <VerdictBadge status={latest.status} />
          ) : (
            !dryRun && <span className="text-[10px] uppercase tracking-wider text-text-secondary">no verdict</span>
          )}
        </span>
      </div>

      {intent.reason && <p className="text-[12px] text-text-muted break-words">{intent.reason}</p>}

      {timeline.length > 0 && (
        <ol className="flex flex-col gap-0.5 text-[10px] tabular">
          {timeline.map((v, i) => (
            <li key={`${v.ts}-${i}`} className="flex flex-wrap items-center gap-x-2 text-text-secondary">
              <span className="text-text-muted uppercase">{v.status}</span>
              <span>by {v.by}</span>
              {v.reason && <span className="text-text-muted">{v.reason}</span>}
              <span>{fmtTsSec(v.ts)}</span>
            </li>
          ))}
        </ol>
      )}

      {actionable && (
        <div className="flex gap-2">
          {onApprove && (
            <Button tier="neutral" onClick={() => onApprove(intent)} disabled={busy}>
              APPROVE
            </Button>
          )}
          {onReject && (
            <Button tier="danger" onClick={() => onReject(intent)} disabled={busy}>
              REJECT
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
