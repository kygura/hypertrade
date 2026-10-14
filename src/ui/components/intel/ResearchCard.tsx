import { useNavigate } from 'react-router'
import type { ResearchResult } from '../../../shared/intel'
import { Badge } from '../Badge'
import { Button } from '../Button'
import { SkeletonRows } from '../state'
import { ClaimAge } from './ClaimAge'
import { ClaimList } from './ClaimList'
import { fmtCost, statusTone, statusWord, toClaim } from './research'

// ResearchCard — DESIGN-terminal §16.2. Status line, EXPLANATION (verbatim
// prose, never a Claim), evidence as a ClaimList (OBS/HYP via §2), OPEN
// QUESTIONS, meta line. `capped` / `failed` print only their verbatim reason;
// `running` is a skeleton replaced in place. Confidence is a gray Badge, never
// color-graded. `compact` (asset page body) drops the status line: the row
// above it already has one.

const CONFIDENCE_TITLE = "the model's own confidence in this explanation — not a probability"

export function ResearchCard({
  result: r,
  highlighted = false,
  compact = false,
  flagText,
}: {
  result: ResearchResult
  highlighted?: boolean
  compact?: boolean
  /** Lowercase chip text for a `flag`-triggered run (meta line `FLAG · <text>`). */
  flagText?: string
}) {
  const navigate = useNavigate()
  const answered = r.status === 'found' || r.status === 'no_cause'
  const word = statusWord(r.status)
  const meta = [r.trigger === 'flag' ? (flagText ? `FLAG · ${flagText}` : 'FLAG') : 'MANUAL', `${r.searches} SEARCHES`, fmtCost(r.costUsd), r.model].filter(Boolean)

  return (
    <article
      id={`research-${r.id}`}
      aria-label={`Research: ${r.asset ?? 'no asset'}, ${word.toLowerCase()}`}
      data-status={r.status}
      className={`flex flex-col gap-1.5 px-3 py-2.5 border-b border-border-subtle last:border-b-0 scroll-mt-[100px] ${highlighted ? 'bg-hover shadow-[inset_2px_0_0_var(--color-red-accent)]' : ''}`}
    >
      {!compact && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Badge tone={statusTone(r.status)}>{r.status === 'running' ? <span className="pulse-label">{word}</span> : word}</Badge>
          {r.asset && <span className="text-sm text-text-primary">{r.asset}</span>}
          {r.asset && (
            <span aria-hidden="true" className="text-text-secondary">
              ·
            </span>
          )}
          <span className="min-w-0 break-words text-[12px] text-text-primary">{r.question}</span>
          <span className="ml-auto inline-flex items-center gap-2">
            {answered && (
              <span title={CONFIDENCE_TITLE}>
                <Badge tone="gray">{r.confidence.toUpperCase()}</Badge>
              </span>
            )}
            <ClaimAge ts={r.createdAt} />
          </span>
        </div>
      )}

      {r.status === 'running' ? (
        <SkeletonRows rows={2} />
      ) : r.status === 'capped' ? (
        <p className="flex items-center gap-2 text-[11px] text-text-muted">
          <span aria-hidden="true" className="inline-block w-1.5 h-1.5 bg-amber flex-shrink-0" />
          {r.explanation}
        </p>
      ) : r.status === 'failed' ? (
        <p className="text-[11px] text-text-muted">{r.explanation}</p>
      ) : (
        <>
          {compact && (
            <span title={CONFIDENCE_TITLE} className="self-start">
              <Badge tone="gray">{r.confidence.toUpperCase()}</Badge>
            </span>
          )}
          <div className="flex flex-col gap-0.5">
            <span className="label">EXPLANATION</span>
            <p className="text-[12px] text-text-primary break-words whitespace-pre-line">{r.explanation}</p>
          </div>
          {r.evidence.length > 0 && <ClaimList claims={r.evidence.map(toClaim)} />}
          {r.openQuestions.length > 0 && (
            <div className="flex flex-col gap-0.5">
              <span className="label">OPEN QUESTIONS</span>
              <ul className="flex flex-col gap-0.5">
                {r.openQuestions.map((q, i) => (
                  <li key={i} className="flex gap-2 text-[11px] text-text-muted">
                    <span className="w-[4ch] flex-shrink-0">?</span>
                    <span className="min-w-0 break-words">{q}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[10px] text-text-secondary tabular">
            {meta.map((m, i) => (
              <span key={i}>
                {i > 0 && <span aria-hidden="true">· </span>}
                {m}
              </span>
            ))}
            <span aria-hidden="true">·</span>
            <ClaimAge ts={r.createdAt} />
            {r.asset && (
              <Button tier="ghost" className="ml-auto" onClick={() => navigate(`/asset/${encodeURIComponent(r.asset!)}`)}>
                OPEN {r.asset} →
              </Button>
            )}
          </div>
        </>
      )}
    </article>
  )
}
