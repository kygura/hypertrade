import type { Brief, Catalyst, PositionSourceStatus } from '../../../shared/intel'
import { AnimatedDigits } from '../AnimatedDigits'
import { Badge, StatusDot, type DotStatus } from '../Badge'
import { Button } from '../Button'
import { Panel } from '../Panel'
import { ErrorBlock, OfflineBlock, SkeletonRows } from '../state'
import { fmtTs } from '../strategy/format'
import { claimAgeText } from './ClaimAge'
import { fmtCountdown, hoursSince, hoursUntil } from './format'
import { briefSnapshotTs, noNarrationReason } from './WhatChangedPanel'

// ReviewStrip — DESIGN-terminal §3.3. A Panel without a title header (the
// strip is the header), bg-panel-alt. The view's one xl: how many things
// changed. Since / alerts / next catalyst / FROM TELEGRAM, the sources
// cluster (dot + word, never color alone), and REVIEW NOW.

const SOURCE_LABEL = { manual: 'MANUAL', hl: 'HL', desk: 'DESK' } as const

export const NEWS_ANCHOR = 'terminal-news'
export const CATALYSTS_ANCHOR = 'terminal-catalysts'
export const FLOW_ANCHOR = 'terminal-flow'

function jump(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function Src({ status, label, title, failed }: { status: DotStatus; label: string; title?: string; failed?: boolean }) {
  return (
    <span className={`inline-flex items-center gap-1 ${failed ? 'text-red-text' : 'text-text-secondary'}`} title={title}>
      <StatusDot status={status} />
      {failed && <span aria-hidden="true">✕</span>}
      {label}
      {status !== 'ok' && <span className="sr-only">{failed ? ' failed' : ' degraded'}</span>}
    </span>
  )
}

function snapStatus(ts: string): DotStatus {
  const h = hoursSince(ts)
  return h < 0.5 ? 'ok' : h <= 2 ? 'degraded' : 'down'
}

export function ReviewStrip({
  brief,
  reviewing,
  superseded = false,
  error,
  offline,
  sources,
  alertsCount,
  detectorsCount = 0,
  nextCatalyst,
  fromTelegram,
  onReview,
}: {
  brief: Brief | null
  reviewing: boolean
  /** The shown brief is the previous one while a REVIEW is in flight (§1.5). */
  superseded?: boolean
  error?: string | null
  offline?: string | null
  sources: PositionSourceStatus[] | null
  alertsCount: number
  /** Firing detector chips (§15.3); omitted at 0. */
  detectorsCount?: number
  nextCatalyst?: Catalyst
  fromTelegram: boolean
  onReview: () => void
}) {
  const snapTs = brief ? briefSnapshotTs(brief) : null
  const llmReason = brief ? noNarrationReason(brief) : null
  const ingestBad = brief?.ingest?.some((s) => !s.ok) ?? false
  const ingestTs = brief?.ingest
    ?.map((s) => s.lastRunAt)
    .filter((t): t is string => !!t)
    .sort()
    .at(-1)
  const silent = brief ? brief.silent || brief.items.length === 0 : false

  return (
    <Panel className="!bg-panel-alt">
      {(error || offline) &&
        (offline && !brief ? (
          <OfflineBlock message={offline} onRetry={onReview} />
        ) : (
          <ErrorBlock message={error ?? offline ?? ''} onRetry={onReview} />
        ))}
      {!brief && reviewing ? (
        <SkeletonRows rows={1} />
      ) : (
        brief && (
          <div className="flex flex-col gap-2 px-3 py-2.5">
            <div className={`flex flex-wrap items-baseline gap-x-3 gap-y-1.5 ${superseded ? 'opacity-70' : ''}`}>
              <span className="inline-flex items-baseline gap-2">
                <AnimatedDigits text={String(silent ? 0 : brief.items.length)} className="text-xl tabular text-text-primary" />
                <span className="label">{silent ? 'NOTHING CLEARED THE THRESHOLD' : brief.items.length === 1 ? 'THING CHANGED' : 'THINGS CHANGED'}</span>
              </span>
              {superseded ? (
                <span className="label pulse-label">LAST BRIEF · {claimAgeText(brief.createdAt)} OLD — REVIEWING…</span>
              ) : (
                <span className="label" title={`${fmtTs(brief.since)} · baseline = snapshot nearest your last review`}>
                  SINCE {claimAgeText(brief.since)} AGO
                </span>
              )}
              {alertsCount > 0 && (
                <button type="button" className="label hover:!text-text-primary" onClick={() => jump(NEWS_ANCHOR)}>
                  {alertsCount} {alertsCount === 1 ? 'ALERT' : 'ALERTS'}
                </button>
              )}
              {detectorsCount > 0 && (
                <button type="button" className="label hover:!text-text-primary" onClick={() => jump(FLOW_ANCHOR)}>
                  {detectorsCount} {detectorsCount === 1 ? 'DETECTOR' : 'DETECTORS'}
                </button>
              )}
              {nextCatalyst && (
                <button
                  type="button"
                  className={`label hover:!text-text-primary ${hoursUntil(nextCatalyst.scheduledAt) < 24 ? '!text-amber' : ''}`}
                  title={fmtTs(nextCatalyst.scheduledAt)}
                  onClick={() => jump(CATALYSTS_ANCHOR)}
                >
                  NEXT {nextCatalyst.title} {fmtCountdown(nextCatalyst.scheduledAt)}
                </button>
              )}
              {fromTelegram && <Badge tone="gray">FROM TELEGRAM</Badge>}
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[10px]">
              <span className="label text-[10px]">SOURCES</span>
              {(sources ?? []).map((s) => (
                <Src key={s.source} status={s.ok ? 'ok' : 'down'} label={SOURCE_LABEL[s.source]} title={s.error} failed={!s.ok} />
              ))}
              {snapTs && <Src status={snapStatus(snapTs)} label={`SNAP ${claimAgeText(snapTs)}`} title={fmtTs(snapTs)} />}
              {brief.ingest && brief.ingest.length > 0 && (
                <Src
                  status={ingestBad ? 'degraded' : 'ok'}
                  label={ingestTs ? `NEWS ${claimAgeText(ingestTs)}` : 'NEWS'}
                  title={brief.ingest.map((s) => `${s.source} · ${s.ok ? 'ok' : 'error'} · ${s.lastRunAt ? claimAgeText(s.lastRunAt) : '—'}`).join('\n')}
                />
              )}
              {!silent && <Src status={llmReason ? 'degraded' : 'ok'} label="LLM" title={llmReason ?? undefined} />}
              <span className="ml-auto">
                <Button tier="ghost" onClick={onReview} disabled={reviewing} title="marks now as reviewed — the next brief diffs from here">
                  <span className={reviewing ? 'pulse-label' : undefined}>{reviewing ? 'REVIEWING…' : 'REVIEW NOW'}</span>
                </Button>
              </span>
            </div>
          </div>
        )
      )}
      {!brief && !reviewing && !error && !offline && (
        <div className="flex justify-end px-3 py-2.5">
          <Button tier="ghost" onClick={onReview} title="marks now as reviewed — the next brief diffs from here">
            REVIEW NOW
          </Button>
        </div>
      )}
    </Panel>
  )
}
