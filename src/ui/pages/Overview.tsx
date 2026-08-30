import { useNavigate } from 'react-router'
import { Panel, PanelHeader, PanelBody, Button, MomentumBadge, MetricStat, Sparkline } from '../components'
import { SkeletonRows, EmptyBlock, ErrorBlock, StaleBanner, AgeStamp } from '../components/state'
import { useApi } from '../lib/api'
import { classForPnl } from '../../shared/format'
import type { MarketStateData, SectorsData } from '../../shared/types'

// Overview — DESIGN.md §10.2. 30-second morning read: metrics strip,
// MarketState headline, sector heat, recent branches. Nothing is edited
// here — every panel is a read + a link deeper.

const STALE_METRICS_H = 2
const STALE_ROUTINE_H = 24

function fmtCompactUsd(n: number): string {
  const abs = Math.abs(n)
  const sign = n < 0 ? '-' : ''
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(2)}K`
  return `${sign}$${abs.toFixed(2)}`
}

function pctChange(latest: number | null, previous: number | null): { text: string; positive: boolean } | null {
  if (latest == null || previous == null || previous === 0) return null
  const pct = ((latest - previous) / Math.abs(previous)) * 100
  return { text: `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}% ${pct >= 0 ? '▲' : '▼'}`, positive: pct >= 0 }
}

function fngWord(v: number): string {
  if (v >= 76) return 'EXTREME GREED'
  if (v >= 56) return 'GREED'
  if (v >= 45) return 'NEUTRAL'
  if (v >= 25) return 'FEAR'
  return 'EXTREME FEAR'
}

interface MetricSummaryRow {
  seriesId: string
  ts: string | null
  latest: number | null
  previous: number | null
  delta: number | null
  z30: number | null
}

const METRIC_DEFS: {
  id: string
  label: string
  fmtValue: (v: number) => string
  fmtDelta: (row: MetricSummaryRow) => { text: string; positive: boolean } | null
}[] = [
  {
    id: 'hl.total_oi_usd',
    label: 'TOTAL OI',
    fmtValue: fmtCompactUsd,
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
    fmtValue: fmtCompactUsd,
    fmtDelta: (r) => pctChange(r.latest, r.previous),
  },
]

function MetricsStrip() {
  const ids = METRIC_DEFS.map((d) => d.id).join(',')
  const { data, loading, error, refetch } = useApi<MetricSummaryRow[]>(`/metrics/summary?ids=${ids}`)

  if (loading && !data) return <Panel><SkeletonRows /></Panel>
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

function MarketStateCard() {
  const navigate = useNavigate()
  const { data, loading, error, refetch } = useApi<MarketStateData>('/marketstate')

  return (
    <Panel className="h-full">
      <PanelHeader title="MARKETSTATE">
        {data && <AgeStamp generatedAt={data.generated_at} thresholdHours={STALE_ROUTINE_H} />}
      </PanelHeader>
      <PanelBody>
        {loading && !data ? (
          <SkeletonRows />
        ) : error ? (
          <ErrorBlock message={error} onRetry={refetch} />
        ) : !data || !data.headline ? (
          <EmptyBlock label="no briefing yet — trigger the routine from STATE" />
        ) : (
          <div className="flex flex-col gap-2 p-3">
            <StaleBanner generatedAt={data.generated_at} thresholdHours={STALE_ROUTINE_H} noun="briefing" />
            <span className="text-[16px] text-text-primary">{data.headline}</span>
            <p className="text-[13px] text-text-muted line-clamp-4">{data.tldr}</p>
            <Button tier="ghost" onClick={() => navigate('/state')} className="self-start">
              READ BRIEFING →
            </Button>
          </div>
        )}
      </PanelBody>
    </Panel>
  )
}

function SectorHeatCard() {
  const navigate = useNavigate()
  const { data, loading, error, refetch } = useApi<SectorsData>('/sectors')
  const top = [...(data?.sectors ?? [])].sort((a, b) => b.mindshare_score - a.mindshare_score).slice(0, 6)

  return (
    <Panel className="h-full">
      <PanelHeader title="SECTOR HEAT">
        {data && <AgeStamp generatedAt={data.generated_at} thresholdHours={STALE_ROUTINE_H} />}
      </PanelHeader>
      <PanelBody>
        {loading && !data ? (
          <SkeletonRows />
        ) : error ? (
          <ErrorBlock message={error} onRetry={refetch} />
        ) : top.length === 0 ? (
          <EmptyBlock label="no sectors yet" />
        ) : (
          <div className="flex flex-col">
            {data && <StaleBanner generatedAt={data.generated_at} thresholdHours={STALE_ROUTINE_H} noun="sectors" />}
            {top.map((s) => (
              <button
                key={s.id}
                onClick={() => navigate('/sectors')}
                className="flex items-center justify-between px-3 py-2 border-b border-border-subtle text-left hover:bg-hover"
              >
                <span className="text-[11px] text-text-primary">{s.label}</span>
                <MomentumBadge momentum={s.momentum} />
              </button>
            ))}
            <Button tier="ghost" onClick={() => navigate('/sectors')} className="m-2 self-start">
              ALL SECTORS →
            </Button>
          </div>
        )}
      </PanelBody>
    </Panel>
  )
}

// Shape not yet finalized by the branches worker — GET /api/branches isn't
// mounted yet, so this reads defensively and degrades to ErrorBlock/EmptyBlock
// until that route lands.
interface BranchListItem {
  id: string
  name: string
  updatedAt: string
  result?: { totalReturnPct?: number; equityCurve?: { equity: number }[] } | null
}

function BranchesCard() {
  const navigate = useNavigate()
  const { data, loading, error, refetch } = useApi<BranchListItem[]>('/branches')
  const top = [...(data ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 3)

  return (
    <Panel className="h-full">
      <PanelHeader title="BRANCHES" />
      <PanelBody>
        {loading && !data ? (
          <SkeletonRows />
        ) : error ? (
          <ErrorBlock message={error} onRetry={refetch} />
        ) : top.length === 0 ? (
          <EmptyBlock label="no branches yet" action={{ label: 'CREATE A BRANCH', onClick: () => navigate('/branches') }} />
        ) : (
          <div className="flex flex-col">
            {top.map((b) => {
              const ret = b.result?.totalReturnPct
              const points = b.result?.equityCurve?.map((e) => e.equity) ?? []
              return (
                <button
                  key={b.id}
                  onClick={() => navigate(`/branches/${b.id}`)}
                  className="grid grid-cols-[1fr_auto_80px] items-center gap-3 px-3 py-2 border-b border-border-subtle text-left hover:bg-hover"
                >
                  <span className="text-[11px] text-text-primary truncate">{b.name}</span>
                  <span className={`text-[11px] tabular ${ret == null ? 'text-text-secondary' : classForPnl(ret)}`}>
                    {ret == null ? '--' : `${ret >= 0 ? '+' : ''}${ret.toFixed(1)}% ${ret >= 0 ? '▲' : '▼'}`}
                  </span>
                  <Sparkline points={points} />
                </button>
              )
            })}
            <Button tier="ghost" onClick={() => navigate('/branches')} className="m-2 self-start">
              ALL →
            </Button>
          </div>
        )}
      </PanelBody>
    </Panel>
  )
}

export function Overview() {
  return (
    <div className="max-w-[1440px] mx-auto p-3 md:p-[var(--gutter)] flex flex-col gap-3 lg:grid lg:grid-cols-12 lg:gap-3">
      <div className="lg:col-span-12">
        <MetricsStrip />
      </div>
      <div className="lg:col-span-7">
        <MarketStateCard />
      </div>
      <div className="lg:col-span-5 lg:row-span-2">
        <SectorHeatCard />
      </div>
      <div className="lg:col-span-7">
        <BranchesCard />
      </div>
    </div>
  )
}
