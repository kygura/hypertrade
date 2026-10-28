import { Panel, MetricStat } from '..'
import { SkeletonRows, EmptyBlock, ErrorBlock, OfflineBlock, StaleBanner } from '../state'
import { useApi } from '../../lib/api'
import { fmtUsd } from '../../../shared/format'

// MetricsStrip — docs/design/README.md §10.2. Funding skew, fear/greed, BTC dominance and
// stablecoin cap in the MARKET header; the only UI for those series. Fetches its own data.

const STALE_METRICS_H = 2

export function pctChange(latest: number | null, previous: number | null): { text: string; positive: boolean } | null {
  if (latest == null || previous == null || previous === 0) return null
  const pct = ((latest - previous) / Math.abs(previous)) * 100
  return { text: `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}% ${pct >= 0 ? '▲' : '▼'}`, positive: pct >= 0 }
}

export function fngWord(v: number): string {
  if (v >= 76) return 'EXTREME GREED'
  if (v >= 56) return 'GREED'
  if (v >= 45) return 'NEUTRAL'
  if (v >= 25) return 'FEAR'
  return 'EXTREME FEAR'
}

export interface MetricSummaryRow {
  seriesId: string
  ts: string | null
  latest: number | null
  previous: number | null
  delta: number | null
  z30: number | null
}

export const METRIC_DEFS: {
  id: string
  label: string
  fmtValue: (v: number) => string
  fmtDelta: (row: MetricSummaryRow) => { text: string; positive: boolean } | null
}[] = [
  {
    id: 'hl.total_oi_usd',
    label: 'TOTAL OI',
    fmtValue: (v: number) => fmtUsd(v, { compact: true }),
    fmtDelta: (r) => pctChange(r.latest, r.previous),
  },
  {
    id: 'hl.funding_skew',
    label: 'FUND SKEW',
    fmtValue: (v) => `${v >= 0 ? '+' : ''}${v.toFixed(4)}`,
    fmtDelta: (r) => (r.delta == null ? null : { text: `${r.delta >= 0 ? '+' : ''}${r.delta.toFixed(4)} ${r.delta >= 0 ? '▲' : '▼'}`, positive: r.delta >= 0 }),
  },
  {
    id: 'fng.value',
    label: 'FEAR/GREED',
    fmtValue: (v) => `${Math.round(v)} ${fngWord(v)}`,
    fmtDelta: (r) => (r.delta == null ? null : { text: `${r.delta >= 0 ? '+' : ''}${Math.round(r.delta)} ${r.delta >= 0 ? '▲' : '▼'}`, positive: r.delta >= 0 }),
  },
  {
    id: 'cg.btc_dominance',
    label: 'BTC DOM',
    fmtValue: (v) => `${v.toFixed(1)}%`,
    fmtDelta: (r) => (r.delta == null ? null : { text: `${r.delta >= 0 ? '+' : ''}${r.delta.toFixed(1)}% ${r.delta >= 0 ? '▲' : '▼'}`, positive: r.delta >= 0 }),
  },
  {
    id: 'llama.stablecoin_cap_usd',
    label: 'STABLES',
    fmtValue: (v: number) => fmtUsd(v, { compact: true }),
    fmtDelta: (r) => pctChange(r.latest, r.previous),
  },
]

export function MetricsStrip() {
  const ids = METRIC_DEFS.map((d) => d.id).join(',')
  const { data, loading, error, offline, refetch } = useApi<MetricSummaryRow[]>(`/metrics/summary?ids=${ids}`)

  if (loading && !data) return <Panel><SkeletonRows /></Panel>
  if (offline) return <Panel><OfflineBlock onRetry={refetch} /></Panel>
  if (error) return <Panel><ErrorBlock message={error} onRetry={refetch} /></Panel>
  if (!data || data.length === 0) return <Panel><EmptyBlock label="no metrics yet" /></Panel>

  const bySeriesId = new Map(data.map((d) => [d.seriesId, d]))
  const newestTs = data.reduce<string | null>((acc, d) => (d.ts && (!acc || d.ts > acc) ? d.ts : acc), null)

  return (
    <Panel>
      {newestTs && <StaleBanner generatedAt={newestTs} thresholdHours={STALE_METRICS_H} noun="metrics" />}
      <div className="grid grid-cols-2 md:grid-cols-5 border border-border divide-x divide-y md:divide-y-0 divide-border-subtle">
        {METRIC_DEFS.map((def) => {
          const row = bySeriesId.get(def.id)
          if (!row || row.latest == null) {
            return <MetricStat key={def.id} label={def.label} value="--" />
          }
          const delta = def.fmtDelta(row)
          return (
            <MetricStat
              key={def.id}
              label={def.label}
              value={def.fmtValue(row.latest)}
              delta={delta?.text}
              deltaPositive={delta?.positive ?? null}
              z30={row.z30}
            />
          )
        })}
      </div>
    </Panel>
  )
}
