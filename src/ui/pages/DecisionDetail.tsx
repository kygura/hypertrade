import { useCallback, useState } from 'react'
import { Link, useParams } from 'react-router'
import { ConfirmDialog, ErrorBlock, SkeletonRows } from '../components'
import { engine, errorMessage, useEngine } from '../lib/engine'
import type { Intent } from '../../shared/strategy-protocol'
import { EngineTabs } from '../components/strategy/EngineTabs'
import { EngineOffline, OfflineStrip } from '../components/strategy/EngineOffline'
import { DecisionMeta, DecisionView } from '../components/strategy/DecisionView'
import { ACTION_LABEL } from '../components/strategy/format'

// /decisions/:id — the full record (DecisionView) plus approve/reject on
// proposed intents. Both go through the DESIGN.md §7 Level 2 dialog: title
// = verb + object, body names the intent, confirm is Danger tier labeled
// verb + object, dialog stays open on failure with the verbatim error.
// Approving hands money to a venue; it is the heaviest per-intent action in
// the product, so it gets the same dialog as reject.

type Pending = { kind: 'approve' | 'reject'; intent: Intent }

export function DecisionDetail() {
  const { id } = useParams<{ id: string }>()
  const decision = useEngine(() => engine.getDecision(id!), [id], { enabled: !!id })
  const [pending, setPending] = useState<Pending | null>(null)
  const [busy, setBusy] = useState(false)
  const [dialogError, setDialogError] = useState<string | null>(null)

  const closeDialog = useCallback(() => {
    if (busy) return
    setPending(null)
    setDialogError(null)
  }, [busy])

  if (!id) return null

  async function confirm() {
    if (!pending || !id) return
    setBusy(true)
    setDialogError(null)
    try {
      const updated =
        pending.kind === 'approve' ? await engine.approveIntent(id, pending.intent.id) : await engine.rejectIntent(id, pending.intent.id)
      decision.setData(updated)
      setPending(null)
    } catch (err) {
      setDialogError(errorMessage(err, `${pending.kind} failed`))
    } finally {
      setBusy(false)
    }
  }

  const { data, loading, error, offline, fetchedAt, refetch } = decision

  const describe = (i: Intent) =>
    `${ACTION_LABEL[i.action]} ${i.market}${i.size_usd != null ? ` $${i.size_usd.toLocaleString()}` : ''} on ${i.venue}`

  return (
    <div className="max-w-[1440px] mx-auto p-3 md:p-[var(--gutter)]">
      <EngineTabs />
      <div className="flex items-center gap-2 mb-3 text-[10px] uppercase tracking-wider min-w-0">
        <Link to="/decisions" className="text-text-secondary hover:text-text-primary flex-shrink-0">
          ← DECISIONS
        </Link>
        <span className="text-text-secondary">/</span>
        <span className="text-text-primary truncate">{id}</span>
      </div>

      {loading && !data && (
        <div className="panel">
          <div className="panel-body">
            <SkeletonRows rows={5} />
          </div>
        </div>
      )}
      {!loading && offline && !data && (
        <div className="panel">
          <div className="panel-body">
            <EngineOffline reason={offline} onRetry={refetch} />
          </div>
        </div>
      )}
      {!loading && !offline && error && !data && (
        <div className="panel">
          <div className="panel-body">
            <ErrorBlock message={error} onRetry={refetch} />
          </div>
        </div>
      )}

      {data && (
        <div className="flex flex-col gap-3">
          <div className="panel">
            {offline && <OfflineStrip reason={offline} fetchedAt={fetchedAt} />}
            <div className="panel-header">
              <span className="panel-title">DECISION</span>
              <Link
                to={`/decisions?strategy=${encodeURIComponent(data.strategy_id)}`}
                className="text-[10px] uppercase tracking-wider text-text-secondary hover:text-text-primary"
              >
                ALL {data.strategy_id} →
              </Link>
            </div>
            <div className="panel-body p-3">
              <DecisionMeta decision={data} />
              {error && (
                <div className="mt-2">
                  <ErrorBlock message={error} onRetry={refetch} />
                </div>
              )}
            </div>
          </div>

          <DecisionView
            decision={data}
            busy={busy}
            onApprove={(intent) => setPending({ kind: 'approve', intent })}
            onReject={(intent) => setPending({ kind: 'reject', intent })}
          />
        </div>
      )}

      {pending && (
        <ConfirmDialog
          title={pending.kind === 'approve' ? 'APPROVE INTENT' : 'REJECT INTENT'}
          body={
            pending.kind === 'approve'
              ? `Approve ${describe(pending.intent)}? The venue executes it.`
              : `Reject ${describe(pending.intent)}? The intent is closed without execution.`
          }
          confirmLabel={pending.kind === 'approve' ? 'APPROVE INTENT' : 'REJECT INTENT'}
          onConfirm={confirm}
          onCancel={closeDialog}
          error={dialogError}
          busy={busy}
        />
      )}
    </div>
  )
}
