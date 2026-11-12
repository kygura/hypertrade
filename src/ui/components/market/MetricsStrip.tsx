import { Panel, MetricStat, HowToRead, type Term } from '..'
import { AsyncBody, StaleBanner } from '../state'
import { useApi } from '../../lib/api'
import { isDbUnavailable } from '../../lib/dbUnavailable'
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
    label: 'TOTAL OPEN INTEREST',
    fmtValue: (v: number) => fmtUsd(v, { compact: true }),
    fmtDelta: (r) => pctChange(r.latest, r.previous),
  },
  {
    id: 'hl.funding_skew',
    label: 'FUNDING, OI-WEIGHTED',
    // Stored as an hourly fraction (0.0000125 = 0.00125% per hour): shown in percent so the neutral rate is not "+0.0000".
    fmtValue: (v) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(4)}%/h`,
    fmtDelta: (r) => (r.delta == null ? null : { text: `${r.delta >= 0 ? '+' : ''}${(r.delta * 100).toFixed(4)}% ${r.delta >= 0 ? '▲' : '▼'}`, positive: r.delta >= 0 }),
  },
  {
    id: 'fng.value',
    label: 'FEAR & GREED',
    fmtValue: (v) => `${Math.round(v)} ${fngWord(v)}`,
    fmtDelta: (r) => (r.delta == null ? null : { text: `${r.delta >= 0 ? '+' : ''}${Math.round(r.delta)} ${r.delta >= 0 ? '▲' : '▼'}`, positive: r.delta >= 0 }),
  },
  {
    id: 'cg.btc_dominance',
    label: 'BTC DOMINANCE',
    fmtValue: (v) => `${v.toFixed(1)}%`,
    fmtDelta: (r) => (r.delta == null ? null : { text: `${r.delta >= 0 ? '+' : ''}${r.delta.toFixed(1)}% ${r.delta >= 0 ? '▲' : '▼'}`, positive: r.delta >= 0 }),
  },
  {
    id: 'llama.stablecoin_cap_usd',
    label: 'STABLECOIN CAP',
    fmtValue: (v: number) => fmtUsd(v, { compact: true }),
    fmtDelta: (r) => pctChange(r.latest, r.previous),
  },
]

const TERMS: readonly Term[] = [
  ['TOTAL OPEN INTEREST', 'USD value of all open perp positions on Hyperliquid. The line under it is the percent change since the previous stored reading.'],
  ['FUNDING, OI-WEIGHTED', 'Average hourly funding rate across Hyperliquid perps, weighted by each perp\'s open interest. Positive means longs are paying shorts on balance. The neutral rate is +0.00125% per hour.'],
  ['FEAR & GREED', 'The Crypto Fear & Greed index, 0 to 100, with its band: under 25 extreme fear, 25 to 44 fear, 45 to 55 neutral, 56 to 75 greed, 76 and up extreme greed.'],
  ['BTC DOMINANCE', 'Bitcoin\'s share of total crypto market cap, in percent.'],
  ['STABLECOIN CAP', 'Total market cap of stablecoins in USD.'],
  ['▲ ▼ line', 'Change since the previous stored reading of that series.'],
  ['z', 'How far the latest reading is from the mean of its last 30 stored readings, in standard deviations (needs at least 5). Shown from 1, amber from 2.'],
]

/** No database: one quiet text line with the server's reason, never a card. */
export function MetricsUnavailable({ reason }: { reason: string }) {
  return (
    <p className="px-3 py-1.5 text-xs text-text-secondary break-words" data-metrics-unavailable>
      metrics unavailable{reason ? ` · ${reason}` : ''}. Total open interest, funding, fear and greed, BTC dominance and stablecoin cap show
      here once the metrics database is connected.
    </p>
  )
}

export function MetricsStrip() {
  const ids = METRIC_DEFS.map((d) => d.id).join(',')
  const { data, loading, error, offline, refetch } = useApi<MetricSummaryRow[]>(`/metrics/summary?ids=${ids}`)

  // No database: a quiet unavailable state with the server's reason, not an error banner.
  const dbDown = isDbUnavailable(error)
  if (dbDown && data == null) return <MetricsUnavailable reason={error ?? ''} />

  return (
    <Panel>
      <AsyncBody
        loading={loading}
        data={data}
        error={error}
        offline={offline}
        empty={{ label: 'No metrics stored yet. The collectors write these series on a schedule; values appear after their first run.' }}
        onRetry={refetch}
      >
        {(rows) => {
          const bySeriesId = new Map(rows.map((d) => [d.seriesId, d]))
          const newestTs = rows.reduce<string | null>((acc, d) => (d.ts && (!acc || d.ts > acc) ? d.ts : acc), null)
          return (
            <>
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
              <HowToRead className="px-3 py-1.5" terms={TERMS}>
                Market-wide gauges with their change since the previous reading. A z value appears when a reading is unusual against its own
                recent history.
              </HowToRead>
            </>
          )
        }}
      </AsyncBody>
    </Panel>
  )
}
