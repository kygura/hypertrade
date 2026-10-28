import type { Brief } from '../../../shared/intel'
import { Panel, PanelBody, PanelHeader } from '../Panel'
import { AsyncBody, EmptyBlock, StaleBanner } from '../state'
import { ClaimAge, claimAgeText } from './ClaimAge'
import { ClaimList } from './ClaimList'
import { DiffTable } from './DiffTable'
import { newestTs } from './format'

// WhatChangedPanel — DESIGN-terminal §3.4. Claims (model) over the DiffTable
// (code), ranked by materiality — the rank key is named. Silent brief →
// EmptyBlock with the threshold echoed. Items without lines (LLM down, cap,
// every line dropped) → one no-narration row + the table: the computed
// answer is complete, so never an ErrorBlock for that.

/** Newest snapshot behind the brief: the newest item ts, else the newest observed `snapshot` claim. */
export function briefSnapshotTs(brief: Brief): string | null {
  const fromItems = newestTs(brief.items.map((i) => i.ts))
  if (fromItems) return fromItems
  return newestTs(brief.lines.map((l) => (l.tag === 'observed' && l.source.label.trim().toLowerCase() === 'snapshot' ? l.ts : null)))
}

/** The verbatim reason the brief carries no narration, or null when it has lines (or nothing to narrate). */
export function noNarrationReason(brief: Brief): string | null {
  if (brief.silent || brief.items.length === 0 || brief.lines.length > 0) return null
  return brief.trace?.error || 'every line failed the claim check'
}

export function WhatChangedPanel({
  brief,
  loading,
  superseded = false,
  error,
  offline,
  onRetry,
}: {
  brief: Brief | null
  loading: boolean
  /** A REVIEW is in flight and this is the previous brief (§1.5: rendered at 70%). */
  superseded?: boolean
  error?: string | null
  offline?: string | null
  onRetry: () => void
}) {
  const snapTs = brief ? briefSnapshotTs(brief) : null
  const reason = brief ? noNarrationReason(brief) : null

  return (
    <Panel className="h-full">
      <PanelHeader title="WHAT CHANGED">
        <span className="label">RANKED BY MATERIALITY</span>
        {snapTs && <ClaimAge ts={snapTs} thresholdHours={0.5} />}
      </PanelHeader>
      {snapTs && <StaleBanner generatedAt={snapTs} thresholdHours={2} noun="snapshots" />}
      <PanelBody>
        <AsyncBody loading={loading} data={brief} error={error ?? null} offline={offline} rows={4} empty={{ label: 'no brief yet' }} onRetry={onRetry}>
          {(brief) => (
          <div className={`flex flex-col ${superseded ? 'opacity-70' : ''}`}>
            {brief.silent ? (
              <div className="flex flex-col items-center pb-6">
                <EmptyBlock
                  label={
                    brief.threshold
                      ? `nothing cleared z ≥ ${brief.threshold.minZ} since ${claimAgeText(brief.since)}`
                      : `nothing cleared the threshold since ${claimAgeText(brief.since)}`
                  }
                />
                {brief.diffedCount != null && (
                  <span className="text-xs text-text-secondary -mt-4">{brief.diffedCount} assets diffed · held ∪ watched</span>
                )}
              </div>
            ) : (
              <>
                {reason ? (
                  <p className="flex items-center gap-2 px-3 py-2 text-sm text-text-muted">
                    <span aria-hidden="true" className="inline-block w-1.5 h-1.5 bg-amber flex-shrink-0" />
                    no narration — {reason}
                  </p>
                ) : (
                  brief.lines.length > 0 && (
                    <div className="px-3 py-2">
                      <ClaimList claims={brief.lines} dropped={brief.trace?.dropped} />
                    </div>
                  )
                )}
                <div className="border-t border-border-subtle">
                  <DiffTable items={brief.items} pushMateriality={brief.threshold?.pushMateriality} />
                </div>
              </>
            )}
          </div>
          )}
        </AsyncBody>
      </PanelBody>
    </Panel>
  )
}
