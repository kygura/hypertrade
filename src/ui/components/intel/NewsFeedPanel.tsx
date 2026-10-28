import type { Alert, FeedbackReport, IngestHealth } from '../../../shared/intel'
import { intel, useIntel, type IntelState } from '../../lib/intel'
import { Panel, PanelBody, PanelHeader } from '../Panel'
import { AsyncBody, StaleBanner } from '../state'
import { AlertItem } from './AlertItem'
import { ClaimAge, claimAgeText } from './ClaimAge'
import { fmtSigned, newestTs } from './format'

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

type Bucket = FeedbackReport['buckets'][number]

/** Net vote share in percent: (up − down) / votes. */
function bucketNet(b: Pick<Bucket, 'up' | 'down'>): number {
  const n = b.up + b.down
  return n > 0 ? ((b.up - b.down) / n) * 100 : 0
}

/** FEEDBACK · 7D — the latest weekly report's worst buckets (SPEC I0.12). Read-only: the operator tunes by hand. */
function FeedbackBlock() {
  const report = useIntel(() => intel.feedbackReport(), [])
  const buckets = report.data?.buckets ?? []
  return (
    <section className="flex flex-col gap-1 border-t border-border-subtle px-2 py-2" aria-label="feedback, last 7 days">
      <h3 className="label">FEEDBACK · 7D</h3>
      <AsyncBody
        {...report}
        staleError={false}
        rows={2}
        empty={{ label: 'no noisy buckets this week' }}
        isEmpty={() => buckets.length === 0}
        onRetry={report.refetch}
      >
        {() => (
          <ol className="flex flex-col gap-1.5">
            {buckets.map((b) => (
              <li key={`${b.eventType}|${b.edgeType}|${b.hops}`} className="flex flex-col gap-0.5">
                <span className="text-sm tabular text-text-primary">
                  {b.eventType ?? 'unclassified'} · {b.edgeType ?? 'direct'} · {b.hops} {b.hops === 1 ? 'hop' : 'hops'} · n {b.up + b.down} · net{' '}
                  {fmtSigned(bucketNet(b), 0, '%')}
                </span>
                <span className="text-sm text-text-muted">{b.suggestion}</span>
              </li>
            ))}
          </ol>
        )}
      </AsyncBody>
    </section>
  )
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
        <AsyncBody
          loading={state.loading}
          data={alerts.length === 0 ? null : alerts}
          error={state.error}
          offline={state.offline}
          rows={4}
          empty={{ label: since ? `no news touched your positions since ${claimAgeText(since)}` : 'no news touched your positions' }}
          onRetry={state.refetch}
        >
          {(list) => (
            <div className="flex flex-col">
              {list.map((a) => (
                <AlertItem key={a.id} alert={a} pushMateriality={pushMateriality} onVote={(v) => intel.alertFeedback(a.id, v)} />
              ))}
            </div>
          )}
        </AsyncBody>
        <FeedbackBlock />
      </PanelBody>
    </Panel>
  )
}
