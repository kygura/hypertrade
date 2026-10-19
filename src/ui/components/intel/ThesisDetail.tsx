import { useState } from 'react'
import type { Thesis } from '../../../shared/intel'
import { Badge, type Tone } from '../Badge'
import { Button } from '../Button'
import { ConfirmDialog } from '../ConfirmDialog'
import { ErrorBlock } from '../state'
import { CheckRow, sortChecks } from './CheckRow'
import { ClaimList } from './ClaimList'
import { thesisCounts } from './ThesisList'
import { useAction } from './useAction'

// ThesisDetail — DESIGN-terminal §5.2. The thesis verbatim, the number to
// face (xl contradicted count), RECHECK (code over stored data, no model call)
// and DELETE (Level 2), the checks contradicted-first, the invalidation list
// with its status when it maps to a check, and "what has to be true for this
// to be wrong" as claim lines. A failed recheck keeps the previous results.

type InvalidationStatus = NonNullable<Thesis['invalidation'][number]['status']>
const INVALIDATION_TONE: Record<InvalidationStatus, Tone> = { triggered: 'red', clear: 'green', unknown: 'gray' }

export const THESIS_STALE_H = 24
const HISTORY_SHOWN = 12
type HistoryStatus = NonNullable<Thesis['history']>[number]['checks'][number]['status']
const HISTORY_TONE: Record<HistoryStatus, Tone> = { supported: 'green', contradicted: 'red', unknown: 'gray', triggered: 'red', clear: 'green' }

/** Per-premise status over the last checks, oldest first. Claims then invalidation, as stored. */
function StatusHistory({ thesis }: { thesis: Thesis }) {
  const history = thesis.history ?? []
  if (history.length === 0) return null
  const premises = [...thesis.claims.map((c) => c.text), ...thesis.invalidation.map((i) => i.text)]
  const shown = history.slice(-HISTORY_SHOWN)
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="label">STATUS HISTORY · LAST {shown.length} OF {history.length} CHECKS</h3>
      <ul className="flex flex-col gap-1.5">
        {premises.map((text, i) => (
          <li key={i} className="flex flex-col gap-0.5 text-[12px]">
            <span className="text-text-primary min-w-0 break-words">{text}</span>
            <span className="flex flex-wrap gap-1">
              {shown.map((h, j) => {
                const c = h.checks[i]
                return c ? (
                  <span key={j} title={`${h.ts}${c.value == null ? '' : ` · ${c.value}`}`}>
                    <Badge tone={HISTORY_TONE[c.status]}>{c.status.slice(0, 3).toUpperCase()}</Badge>
                  </span>
                ) : null
              })}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

export function ThesisDetail({
  thesis,
  onRecheck,
  onDelete,
}: {
  thesis: Thesis
  /** Resolves once the recheck landed; throws with the verbatim server error. */
  onRecheck: () => Promise<unknown>
  /** Resolves once deleted; throws with the verbatim server error. */
  onDelete: () => Promise<unknown>
}) {
  const n = thesisCounts(thesis)
  const recheck = useAction(onRecheck)
  const del = useAction(onDelete)
  const [confirming, setConfirming] = useState(false)

  return (
    <div className={`flex flex-col gap-4 p-3 ${recheck.busy ? 'opacity-70' : ''}`}>
      <p className="text-[13px] text-text-muted whitespace-pre-wrap break-words">{thesis.text}</p>

      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="flex items-baseline gap-2">
            <span className={`text-xl tabular ${n.contradicted > 0 ? 'text-red-text' : 'text-text-primary'}`}>{n.contradicted}</span>
            <span className="label">CONTRADICTED</span>
          </span>
          <span className="text-[11px] tabular text-text-muted">
            {n.supported} SUPPORTED · {n.unknown} UNKNOWN
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button tier="neutral" onClick={() => void recheck.run()} disabled={recheck.busy || del.busy}>
            <span className={recheck.busy ? 'pulse-label' : undefined}>{recheck.busy ? 'CHECKING…' : 'RECHECK'}</span>
          </Button>
          <Button tier="danger" className="ml-auto" onClick={() => setConfirming(true)} disabled={del.busy}>
            DELETE
          </Button>
        </div>
        {recheck.error && <ErrorBlock message={recheck.error} onRetry={() => void recheck.run()} />}
      </div>

      <section className="flex flex-col">
        <h3 className="label">CLAIMS &amp; ASSUMPTIONS</h3>
        {thesis.claims.length === 0 ? (
          <p className="text-[11px] text-text-secondary py-2">no claims extracted</p>
        ) : (
          <ol>
            {sortChecks(thesis.claims).map((c, i) => (
              <CheckRow key={`${c.status}-${i}-${c.text}`} check={c} />
            ))}
          </ol>
        )}
      </section>

      {thesis.invalidation.length > 0 && (
        <section className="flex flex-col gap-1.5">
          <h3 className="label">INVALIDATION</h3>
          <ul className="flex flex-col gap-1">
            {thesis.invalidation.map((inv, i) => (
              <li key={i} className="flex flex-wrap items-baseline gap-2 text-[12px] text-text-primary">
                <span aria-hidden="true" className="text-text-secondary">
                  ·
                </span>
                <span className="min-w-0 break-words">{inv.text}</span>
                {inv.status && <Badge tone={INVALIDATION_TONE[inv.status]}>{inv.status.toUpperCase()}</Badge>}
              </li>
            ))}
          </ul>
        </section>
      )}

      <StatusHistory thesis={thesis} />

      {thesis.wrongIf.length > 0 && (
        <section className="flex flex-col gap-1.5">
          <h3 className="label">WHAT HAS TO BE TRUE FOR THIS TO BE WRONG</h3>
          <ClaimList claims={thesis.wrongIf} dropped={thesis.trace?.dropped} />
        </section>
      )}

      <p className="text-[10px] text-text-secondary">checks are code over stored data; the model only extracted them · not advice</p>

      {confirming && (
        <ConfirmDialog
          title="DELETE THESIS"
          body="Delete this thesis and its check history?"
          confirmLabel="DELETE THESIS"
          busy={del.busy}
          error={del.error}
          onCancel={() => {
            setConfirming(false)
            del.clear()
          }}
          onConfirm={async () => {
            const ok = await del.run()
            if (ok !== undefined) setConfirming(false)
          }}
        />
      )}
    </div>
  )
}
