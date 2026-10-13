import type { Alert, IngestHealth } from '../../../shared/intel'
import { intel, type IntelState } from '../../lib/intel'
import { Panel, PanelBody, PanelHeader } from '../Panel'
import { EmptyBlock, ErrorBlock, OfflineBlock, SkeletonRows, StaleBanner } from '../state'
import { AlertItem } from './AlertItem'
import { ClaimAge, claimAgeText } from './ClaimAge'
import { newestTs } from './format'

// NewsFeedPanel (NEWS → POSITIONS) — DESIGN-terminal §3.5. Alerts since
// brief.since (polled 60 s by the page) plus the batched alerts merged into
// the brief, newest first. Header age = last ingest run (else newest alert);
// amber > 30 min, StaleBanner > 2 h.

/** Polled alerts ∪ the brief's batched alerts, deduped by id, newest first. */
export function mergeAlerts(polled: Alert[] | null, batched: Alert[] = []): Alert[] {
  const byId = new Map<string, Alert>()
  for (const a of batched) byId.set(a.id, a)
  for (const a of polled ?? []) byId.set(a.id, a) // the poll carries the fresher feedback
  return [...byId.values()].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
}

export function NewsFeedPanel({
  state,
  batched,
  since,
  ingest,
  pushMateriality,
}: {
  state: IntelState<Alert[]>
  batched: Alert[]
  since: string | null
  ingest?: IngestHealth[]
  pushMateriality?: number
}) {
  const alerts = mergeAlerts(state.data, batched)
  const ingestTs = ingest ? newestTs(ingest.map((s) => s.lastRunAt)) : null
  const ageTs = ingestTs ?? newestTs(alerts.map((a) => a.createdAt))
  const noun = ingestTs ? 'news ingest' : 'news'

  return (
    <Panel className="h-full">
      <PanelHeader title="NEWS → POSITIONS">{ageTs && <ClaimAge ts={ageTs} thresholdHours={0.5} />}</PanelHeader>
      {ageTs && <StaleBanner generatedAt={ageTs} thresholdHours={2} noun={noun} />}
      <PanelBody>
        {state.offline && alerts.length === 0 ? (
          <OfflineBlock message={state.offline} onRetry={state.refetch} />
        ) : state.error && alerts.length === 0 ? (
          <ErrorBlock message={state.error} onRetry={state.refetch} />
        ) : state.loading && alerts.length === 0 ? (
          <SkeletonRows rows={4} />
        ) : alerts.length === 0 ? (
          <EmptyBlock label={since ? `no news touched your positions since ${claimAgeText(since)}` : 'no news touched your positions'} />
        ) : (
          <div className="flex flex-col">
            {(state.error || state.offline) && <ErrorBlock message={state.error ?? state.offline ?? ''} onRetry={state.refetch} />}
            {alerts.map((a) => (
              <AlertItem key={a.id} alert={a} pushMateriality={pushMateriality} onVote={(v) => intel.alertFeedback(a.id, v)} />
            ))}
          </div>
        )}
      </PanelBody>
    </Panel>
  )
}
