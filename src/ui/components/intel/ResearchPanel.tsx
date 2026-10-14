import { useEffect, useRef } from 'react'
import type { ResearchResult } from '../../../shared/intel'
import type { IntelState, ResearchListResponse } from '../../lib/intel'
import { Panel, PanelBody, PanelHeader } from '../Panel'
import { EmptyBlock, ErrorBlock, OfflineBlock, SkeletonRows } from '../state'
import { ClaimAge } from './ClaimAge'
import { ResearchAsk } from './ResearchAsk'
import { ResearchCard } from './ResearchCard'

// ResearchPanel — DESIGN-terminal §16.1. RESEARCH · NEWEST FIRST, the usage
// line (`3 / 10 TODAY`, amber at the limit), the ask box (always rendered),
// then one ResearchCard per result. While a POST is in flight a `running`
// placeholder card leads the list. A card addressed by `highlightId` is
// scrolled to once and carries the selection inset until the next click.

export const RESEARCH_ANCHOR = 'terminal-research'
const EMPTY = 'no research yet — ask a question above, or press RESEARCH on a detector chip'
const USAGE_TITLE = 'manual research runs this UTC day · INTEL_RESEARCH_DAILY'

export function ResearchPanel({
  state,
  ask,
  items,
  pending,
  heldWatched,
  highlightId,
  disabledReason,
  flagText,
  onAsk,
}: {
  state: IntelState<ResearchListResponse>
  /** The ask useAction, shared with the chip action. */
  ask: { busy: boolean; error: string | null; status: number | null; offline: boolean }
  /** Locally prepended results merged with the poll (mergeResearch: deduplicated, newest first, ≤ 20). */
  items: ResearchResult[]
  /** The question in flight, rendered as the `running` placeholder. */
  pending: { question: string; asset: string | null } | null
  heldWatched: Set<string>
  highlightId: string | null
  disabledReason: string | null
  flagText?: (flagId: string) => string | undefined
  onAsk: (input: { question: string; asset?: string }, onResult?: () => void) => boolean
}) {
  const d = state.data
  const atLimit = d?.usedToday != null && d.limit != null && d.usedToday >= d.limit
  const scrolled = useRef<string | null>(null)
  const found = highlightId != null && items.some((r) => r.id === highlightId)

  useEffect(() => {
    if (!highlightId) scrolled.current = null
    if (!highlightId || !found || scrolled.current === highlightId) return
    scrolled.current = highlightId
    document.getElementById(`research-${highlightId}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [highlightId, found])

  // the poll's own running row replaces the placeholder (never two RUNNING cards)
  const placeholder: ResearchResult | null = pending && !items.some((r) => r.status === 'running')
    ? { id: 'pending', trigger: 'manual', asset: pending.asset, question: pending.question, status: 'running', explanation: '', evidence: [], confidence: 'low', openQuestions: [], searches: 0, costUsd: 0, model: '', createdAt: new Date().toISOString() }
    : null

  return (
    <Panel>
      <PanelHeader title="RESEARCH">
        <span className="label">NEWEST FIRST</span>
        <span className="ml-auto inline-flex items-center gap-2">
          {d?.usedToday != null && d.limit != null && (
            <span className={`text-[10px] tabular ${atLimit ? 'text-amber' : 'text-text-secondary'}`} title={USAGE_TITLE}>
              {d.usedToday} / {d.limit} TODAY
            </span>
          )}
          {items[0] && <ClaimAge ts={items[0].createdAt} />}
        </span>
      </PanelHeader>
      <PanelBody>
        <ResearchAsk
          assets={[...heldWatched].sort()}
          busy={ask.busy}
          disabledReason={disabledReason}
          error={ask.error}
          status={ask.status}
          offline={ask.offline}
          onSubmit={onAsk}
        />
        <div className="border-t border-border-subtle">
          {(state.offline || state.error) &&
            (state.offline ? <OfflineBlock message={state.offline} onRetry={state.refetch} /> : <ErrorBlock message={state.error ?? ''} onRetry={state.refetch} />)}
          {!d && !placeholder ? (
            state.error || state.offline ? null : <SkeletonRows rows={3} />
          ) : items.length === 0 && !placeholder ? (
            <EmptyBlock label={EMPTY} />
          ) : (
            <div>
              {placeholder && <ResearchCard result={placeholder} />}
              {items.map((r) => (
                <ResearchCard key={r.id} result={r} highlighted={r.id === highlightId} flagText={r.flagId ? flagText?.(r.flagId) : undefined} />
              ))}
            </div>
          )}
        </div>
      </PanelBody>
    </Panel>
  )
}
