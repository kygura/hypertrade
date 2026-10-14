import { useEffect, useRef, useState } from 'react'
import type { Alert } from '../../../shared/intel'
import { errorMessage } from '../../lib/poll'
import { Badge } from '../Badge'
import { Button } from '../Button'
import { ErrorBlock } from '../state'
import { ClaimAge } from './ClaimAge'
import { ClaimLine } from './ClaimLine'
import { ExposurePathChips } from './ExposurePathChips'
import { fmtSigned } from './format'
import { SourceLink } from './SourceLink'

// AlertItem — DESIGN-terminal §3.5. One alert as an <article>: materiality,
// PUSHED/BATCHED, age, kind word, feedback (USEFUL / NOISE words, not emoji);
// the claim line + priced-in suffix (signs, no green/red: context, not PnL);
// the exposure path; one SourceLink per cluster source. Feedback is Level 1,
// optimistic: failure reverts and shows a compact ErrorBlock. No un-vote.

export type Vote = 1 | -1

/**
 * Optimistic vote with rollback: `set(vote)` now, then `send()`; on failure
 * `set(prev)` and return the verbatim error (null on success).
 */
export async function castVote(
  prev: Alert['feedback'],
  vote: Vote,
  send: () => Promise<void>,
  set: (v: Alert['feedback']) => void,
): Promise<string | null> {
  set(vote)
  try {
    await send()
    return null
  } catch (err) {
    set(prev)
    return errorMessage(err, 'vote failed')
  }
}

export function kindWord(a: Pick<Alert, 'kind' | 'window'>): string | null {
  if (a.kind === 'catalyst') return a.window ? `CATALYST T−${a.window.toUpperCase()}` : 'CATALYST'
  if (a.kind === 'docwatch') return 'WATCH CHANGE'
  if (a.kind === 'terminal') return 'TERMINAL'
  return null
}

export function pricedInText(p: Alert['pricedIn']): string | null {
  if (!p) return null
  const parts = [`already ${fmtSigned(p.pricePct, 1, '%')}`]
  if (p.oiPct != null) parts.push(`OI ${fmtSigned(p.oiPct, 0, '%')}`)
  return `· ${parts.join(', ')}`
}

export function AlertItem({
  alert,
  onVote,
  pushMateriality,
}: {
  alert: Alert
  onVote: (vote: Vote) => Promise<void>
  pushMateriality?: number
}) {
  const [vote, setVote] = useState<Alert['feedback']>(alert.feedback)
  const [error, setError] = useState<string | null>(null)
  const pending = useRef(false)

  // A poll can bring the stored vote; never clobber an in-flight optimistic one.
  useEffect(() => {
    if (!pending.current) setVote(alert.feedback)
  }, [alert.feedback])

  const cast = async (v: Vote) => {
    if (pending.current || vote === v) return
    pending.current = true
    setError(null)
    const err = await castVote(vote, v, () => onVote(v), setVote)
    pending.current = false
    setError(err)
  }

  const mat = alert.materiality.toFixed(2)
  const kind = kindWord(alert)
  const priced = pricedInText(alert.pricedIn)
  const amber = pushMateriality != null && alert.materiality >= pushMateriality

  return (
    <article aria-label={`Alert: ${alert.asset}, materiality ${mat}`} className="flex flex-col gap-1.5 px-3 py-2.5 border-b border-border-subtle last:border-b-0">
      <div className="flex flex-wrap items-center gap-2 text-[10px]">
        <span className={`tabular ${amber ? 'text-amber' : 'text-text-primary'}`}>{mat}</span>
        {alert.route === 'push' ? <Badge tone="amber">PUSHED</Badge> : <Badge tone="gray">BATCHED</Badge>}
        <ClaimAge ts={alert.createdAt} />
        {kind && <span className="label text-[10px]">{kind}</span>}
        <span className="ml-auto flex gap-1.5">
          <Button
            tier="ghost"
            aria-label="mark alert useful"
            aria-pressed={vote === 1}
            onClick={() => void cast(1)}
            className={vote === 1 ? 'text-text-primary' : ''}
          >
            {vote === 1 ? '✓ USEFUL' : 'USEFUL'}
          </Button>
          <Button
            tier="ghost"
            aria-label="mark alert as noise"
            aria-pressed={vote === -1}
            onClick={() => void cast(-1)}
            className={vote === -1 ? 'text-text-primary' : ''}
          >
            {vote === -1 ? '✓ NOISE' : 'NOISE'}
          </Button>
        </span>
      </div>
      <div className="flex flex-col gap-0.5">
        <ClaimLine claim={alert.line} />
        {priced && <span className="pl-[calc(4ch+0.5rem)] text-[11px] text-text-muted tabular">{priced}</span>}
      </div>
      {alert.path.length > 0 && <ExposurePathChips path={alert.path} weight={alert.pathWeight} />}
      {alert.sources.length > 0 && (
        <span className="flex flex-wrap items-center gap-1 text-[10px] text-text-secondary">
          {alert.sources.map((s, i) => (
            <span key={i} className="inline-flex items-center gap-1">
              {i > 0 && <span aria-hidden="true">·</span>}
              <SourceLink source={s} />
            </span>
          ))}
        </span>
      )}
      {error && <ErrorBlock message={error} />}
    </article>
  )
}
