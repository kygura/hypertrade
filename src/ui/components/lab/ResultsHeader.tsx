import { Badge } from '../Badge'
import { AgeStamp } from '../state'
import { shortId, fmtUtcStamp, type SearchResult } from '../../lib/lab'

// ResultsHeader — DESIGN.md §10.9. Run id (4 chars, full in title), config,
// data range, holdout start, features, trials (PARTIAL when cut short),
// duration, the run's age, then the rank key named aloud (rule 2).

export function ResultsHeader({ runId, createdAt, result }: { runId: string | null; createdAt: string; result: SearchResult }) {
  const c = result.config
  const partial = result.trialsRun < c.trials
  return (
    <div className="flex flex-col gap-1 px-3 py-2 border-b border-border-subtle">
      <div className="text-sm tabular flex flex-wrap gap-x-2">
        <span title={runId ?? 'not stored'}>RUN {shortId(runId)}</span>
        <span className="text-text-secondary">·</span>
        <span>{fmtUtcStamp(createdAt)}</span>
        <span className="text-text-secondary">·</span>
        <span>
          {c.asset.toUpperCase()} {c.direction.toUpperCase()} {c.horizonDays}D
        </span>
        <span className="text-text-secondary">·</span>
        <span>
          {result.dataRange.from} → {result.dataRange.to}
        </span>
      </div>
      <div className="text-xs tabular text-text-secondary flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-info">HOLDOUT FROM {result.dataRange.holdoutFrom}</span>
        <span>·</span>
        <span>{result.featureCount} FEATURES</span>
        <span>·</span>
        <span className={partial ? 'text-amber' : undefined}>
          {result.trialsRun}/{c.trials} TRIALS
        </span>
        {partial && <Badge tone="amber">PARTIAL</Badge>}
        <span>·</span>
        <span>{(result.durationMs / 1000).toFixed(1)} s</span>
        <span>·</span>
        <AgeStamp generatedAt={createdAt} thresholdHours={48} />
      </div>
      <span className="label" title="walk-forward: thresholds refit per fold">
        RANKED BY WALK-FORWARD {c.objective === 'return' ? 'RETURN' : 'SHARPE'}
      </span>
    </div>
  )
}
