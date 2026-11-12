import { useState } from 'react'
import { Badge, Button } from '../../components'
import type { OpportunityDetail } from '../../../shared/platform'
import { api, ApiError } from '../../lib/api'
import type { DeskStatus } from '../../lib/desk'
import { fmtPx } from '../../lib/format'
import { actionFailure, platform, PLATFORM_POLL } from '../../lib/platformApi'
import { usePoll } from '../../lib/poll'
import { canApprove, canReject, RejectDialog, TicketDialog } from '../cockpit/Detail'
import { approveBlockedReason, STATUS_WORD } from '../cockpit/logic'
import { setupFacts } from './logic'

// SETUP — the ready opportunity for this coin, decided where the coin is read (docs/SPEC.md § Queue, COIN).
// The same gates as the feed: the server's freshness gate (canApprove), then the governor preview; APPROVE
// opens the ticket dialog and only CONFIRM posts. An approve that cannot succeed is disabled with its reason.

type Venue = 'paper' | 'testnet' | null
type Dialog = 'approve' | 'reject' | null

/** Container: the opportunity detail (15 s) and the desk venue (30 s), and the two POSTs. */
export function SetupApprove({ oppId, onDecided }: { oppId: string; onDecided?: () => void }) {
  const detail = usePoll<OpportunityDetail | null>(() => platform.detail(oppId), [oppId], { intervalMs: 15_000, ...PLATFORM_POLL })
  const desk = usePoll(() => api.get<DeskStatus>('/desk/status'), [], { intervalMs: 30_000 })
  const [dialog, setDialog] = useState<Dialog>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [stale, setStale] = useState<string | null>(null)

  const open = (k: Dialog) => {
    setError(null)
    setStale(null)
    setDialog(k)
  }
  const run = async (fn: () => Promise<unknown>, approving: boolean) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      setStale(null)
      setDialog(null)
      onDecided?.()
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return
      const f = actionFailure(e)
      if (approving && f.stale) setStale(f.stale)
      else setError(f.message)
    } finally {
      setBusy(false)
      detail.refetch()
    }
  }
  const d = detail.data
  const venue: Venue = desk.data ? (desk.data.live ? 'testnet' : 'paper') : null
  return (
    <>
      <SetupApproveView
        detail={d}
        unavailable={detail.offline ?? detail.error ?? (detail.loading ? null : d == null ? 'this opportunity no longer exists' : null)}
        busy={busy}
        onApprove={() => open('approve')}
        onReject={() => open('reject')}
      />
      {dialog === 'approve' && d && (
        <TicketDialog detail={d} venue={venue} busy={busy} error={error} stale={stale} onConfirm={() => void run(() => platform.approve(oppId), true)} onCancel={() => setDialog(null)} />
      )}
      {dialog === 'reject' && d && <RejectDialog busy={busy} error={error} onConfirm={(reason) => void run(() => platform.reject(oppId, reason), false)} onCancel={() => setDialog(null)} />}
    </>
  )
}

/** Presentational: the setup's facts, APPROVE and REJECT, and why APPROVE is disabled when it is. */
export function SetupApproveView({
  detail: d,
  unavailable,
  busy,
  onApprove,
  onReject,
}: {
  detail: OpportunityDetail | null
  /** Why there is no detail to decide on; null while loading or when there is one. */
  unavailable: string | null
  busy: boolean
  onApprove: () => void
  onReject: () => void
}) {
  if (!d) {
    return unavailable ? (
      <p className="px-3 py-2 text-xs text-text-secondary border-t border-border-subtle" data-block="setup">
        SETUP · {unavailable}
      </p>
    ) : null
  }
  const o = d.opportunity
  const blocked = approveBlockedReason(d, null)
  const ready = canApprove(o.status)
  return (
    <section aria-label={`${o.coin} setup`} data-block="setup" className="flex flex-col gap-1.5 px-3 py-2 border-t border-border-subtle min-w-0">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs min-w-0">
        <Badge tone="gray">SETUP</Badge>
        <span className="text-text-primary">
          {o.setupKind} · {o.direction} · {STATUS_WORD[o.status]}
        </span>
        <span className="tabular text-text-secondary">{setupFacts(o, d.ticket, fmtPx)}</span>
      </div>
      {o.invalidation && <p className="text-xs text-text-secondary break-words">invalidation: {o.invalidation}</p>}
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          tier="neutral"
          className="min-h-[var(--tap-min)]"
          onClick={onApprove}
          disabled={busy || !ready || blocked != null}
          title={blocked ?? (ready ? 'opens the ticket; nothing is sent before CONFIRM' : `approve needs READY — status is ${STATUS_WORD[o.status]}`)}
        >
          APPROVE
        </Button>
        <Button tier="ghost" className="min-h-[var(--tap-min)]" onClick={onReject} disabled={busy || !canReject(o.status)}>
          REJECT
        </Button>
      </div>
      {blocked != null && ready && <p className="text-xs text-amber">approve blocked: {blocked}</p>}
    </section>
  )
}
