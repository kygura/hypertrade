import { useMemo, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router'
import { fmtPrice, fmtUsd } from '../../../shared/format'
import type { AssetDetailResponse, ExposurePosition, FlowFlag } from '../../../shared/intel'
import { Badge } from '../../components/Badge'
import { Button } from '../../components/Button'
import { AssetTimeline, paneOf, timelineRows } from '../../components/intel/AssetTimeline'
import { ClaimAge } from '../../components/intel/ClaimAge'
import { ResearchSuffix } from '../../components/intel/DetectorChips'
import { EventList } from '../../components/intel/EventList'
import { ExposureGraph } from '../../components/intel/ExposureGraph'
import { firingChips, flagWord, FLOW_NO_SOURCE, flowSourceText } from '../../components/intel/flow'
import { readFlowWindow } from '../../components/intel/FlowPanel'
import { fmtLeverage, fmtStopDist, newestTs, useNow } from '../../components/intel/format'
import { stopDistPct } from '../../components/intel/PositionsTable'
import { TerminalTabs } from '../../components/intel/TerminalTabs'
import { Panel, PanelBody, PanelHeader } from '../../components/Panel'
import { Segmented, type SegmentOption } from '../../components/Segmented'
import { SrcTag } from '../../components/SrcTag'
import { EmptyBlock, ErrorBlock, OfflineBlock, SkeletonRows, StaleBanner } from '../../components/state'
import { ApiError } from '../../lib/api'
import { intel, INTEL_POLL_MS, useIntel } from '../../lib/intel'

// `/asset/:coin` — AssetPage (docs/design/terminal.md §15.4). A drill-in of `/terminal` under
// TerminalTabs (TERMINAL active). Owns `?days=1|7|30` (default 7) and
// `?metric=` (highlights a pane until any click). Polls the asset on mount,
// on days change and every 5 min; reads positions (held lines, stop) and the
// heatmap (materiality, flags, flow source status) like `/terminal` does.
// Mobile order: header → TIMELINE → EVENTS → EXPOSURE.

type Days = 1 | 7 | 30
const DAYS: readonly SegmentOption<Days>[] = [
  { value: 1, label: '1D' },
  { value: 7, label: '7D' },
  { value: 30, label: '30D' },
]
const DAYS_WORD: Record<Days, string> = { 1: '1 day', 7: '7 days', 30: '30 days' }

const parseDays = (v: string | null): Days => (v === '1' ? 1 : v === '30' ? 30 : 7)

/** 404 → 'missing' (unknown coin), not an error. */
async function fetchAsset(coin: string, days: number): Promise<AssetDetailResponse | 'missing'> {
  try {
    return await intel.asset(coin, days)
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return 'missing'
    throw err
  }
}

function AssetHeader({
  coin,
  positions,
  row,
  flags,
  snapTs,
  lastPrice,
  days,
  onDays,
}: {
  coin: string
  positions: ExposurePosition[]
  row: { held: boolean; materiality: number } | undefined
  flags: FlowFlag[]
  snapTs: string | null
  lastPrice: number | null
  days: Days
  onDays: (d: Days) => void
}) {
  const navigate = useNavigate()
  const held = positions.length > 0
  const mark = positions[0]?.markPx ?? lastPrice
  const stops = positions.filter((p) => p.stopPx != null)
  return (
    <Panel className="!bg-panel-alt">
      <div className="flex flex-col gap-1.5 px-3 py-2.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <Button tier="ghost" onClick={() => navigate('/terminal')}>
            ← TERMINAL
          </Button>
          <span className="text-lg text-text-primary">{coin}</span>
          {(held || row) && <span className={`text-[9px] uppercase tracking-wider ${held ? 'text-text-primary' : 'text-text-secondary'}`}>{held ? 'HELD' : 'WATCH'}</span>}
          {positions.map((p) => (
            <span key={p.id} className="inline-flex items-center gap-1.5 text-[11px] tabular">
              <span className={p.side === 'long' ? 'text-green' : 'text-red-text'}>
                {p.side === 'long' ? 'LONG' : 'SHORT'} {fmtLeverage(p.leverage)}
              </span>
              <span className="text-text-primary">
                {p.size.toLocaleString(undefined, { maximumFractionDigits: 6 })} {coin} · {fmtUsd(p.notionalUsd, { compact: true })}
              </span>
              <SrcTag source={p.source} />
            </span>
          ))}
          <span className="ml-auto">
            <Segmented label="asset window" size="sm" options={DAYS} value={days} onChange={onDays} />
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] tabular">
          {mark != null && <span className="text-text-primary">MARK {fmtPrice(mark)}</span>}
          {held &&
            (stops.length > 0 ? (
              stops.map((p) => (
                <span key={p.id} className="text-text-primary" title={`stop ${fmtPrice(p.stopPx!)}`}>
                  STOP {fmtStopDist(stopDistPct(p))}
                </span>
              ))
            ) : (
              <Badge tone="amber">NO STOP</Badge>
            ))}
          {row && <span className="text-text-primary">MAT {row.materiality.toFixed(2)}</span>}
          {flags.length > 0 && (
            <span className="inline-flex flex-wrap items-center gap-1">
              <span className="label">FLAGS</span>
              {flags.map((f) => (
                <Badge key={f.id} tone="gray">
                  {flagWord(f).toLowerCase()}
                  {f.researchId && <ResearchSuffix />}
                </Badge>
              ))}
            </span>
          )}
          <span className="ml-auto inline-flex items-center gap-2">
            {snapTs && (
              <span className="inline-flex items-center gap-1">
                <SrcTag source="snap" />
                <ClaimAge ts={snapTs} thresholdHours={0.5} />
              </span>
            )}
            <Button tier="ghost" onClick={() => navigate(`/markets/${encodeURIComponent(coin)}`)}>
              CHART →
            </Button>
          </span>
        </div>
      </div>
    </Panel>
  )
}

export function Asset() {
  const { coin = '' } = useParams<{ coin: string }>()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const days = parseDays(params.get('days'))
  const [highlight, setHighlight] = useState(() => paneOf(params.get('metric')))
  const [hot, setHot] = useState<string | null>(null)
  const now = useNow()

  const asset = useIntel(() => fetchAsset(coin, days), [coin, days], { intervalMs: INTEL_POLL_MS.asset, enabled: !!coin })
  const positions = useIntel(intel.positions, [], { intervalMs: INTEL_POLL_MS.positions })
  const heatmap = useIntel(() => intel.heatmap(readFlowWindow()), [], { intervalMs: INTEL_POLL_MS.heatmap })

  const d = asset.data === 'missing' ? null : asset.data
  const mine = useMemo(() => positions.data?.positions.filter((p) => p.asset === coin) ?? [], [positions.data, coin])
  const hm = heatmap.data
  const row = hm?.rows.find((r) => r.asset === coin)
  const flags = hm ? firingChips(hm.flags, new Map()).filter((f) => f.asset === coin) : []
  const rows = useMemo(() => (d ? timelineRows(d.snapshots, d.flow) : []), [d])
  const snapTs = d ? newestTs(d.snapshots.map((s) => s.ts)) : null
  const events = useMemo(() => (d ? [...d.events].sort((a, b) => b.ts.localeCompare(a.ts)) : []), [d])
  const upcoming = useMemo(() => {
    if (!d) return []
    const seen = new Set(events.filter((e) => e.kind === 'catalyst').map((e) => e.title))
    return d.catalysts.filter((c) => Date.parse(c.scheduledAt) > now && !seen.has(c.title)).sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt))
  }, [d, events, now])
  // Without the heatmap the flow status is unknown: show the pane (empty when there are no rows).
  const flowOk = hm ? hm.flow.ok : true
  const flowNote = hm ? flowSourceText(hm.flow) : FLOW_NO_SOURCE

  const setDays = (n: Days) =>
    setParams(
      (p) => {
        p.set('days', String(n))
        return p
      },
      { replace: true },
    )
  const failed = (onRetry: () => void) =>
    asset.offline && !asset.data ? <OfflineBlock message={asset.offline} onRetry={onRetry} /> : asset.error && !asset.data ? <ErrorBlock message={asset.error} onRetry={onRetry} /> : null

  return (
    <div className="max-w-[1440px] mx-auto px-3 pb-3 md:px-[var(--gutter)] md:pb-[var(--gutter)] flex flex-col" onClickCapture={() => setHighlight(null)}>
      <TerminalTabs />
      <div className="flex flex-col gap-3 lg:grid lg:grid-cols-12 lg:items-start">
        <div className="lg:col-span-12">
          {!asset.data && !asset.error && !asset.offline ? (
            <Panel className="!bg-panel-alt">
              <SkeletonRows rows={1} />
            </Panel>
          ) : (
            <AssetHeader coin={coin} positions={mine} row={row} flags={flags} snapTs={snapTs} lastPrice={rows.at(-1)?.price ?? null} days={days} onDays={setDays} />
          )}
        </div>
        {asset.data === 'missing' ? (
          <div className="lg:col-span-12">
            <Panel>
              <EmptyBlock label={`no data for ${coin}`} action={{ label: '← TERMINAL', onClick: () => navigate('/terminal') }} />
            </Panel>
          </div>
        ) : (
          <>
            <div className="lg:col-span-8 flex flex-col gap-3 min-w-0">
              <Panel>
                <PanelHeader title="TIMELINE" />
                {snapTs && <StaleBanner generatedAt={snapTs} thresholdHours={2} noun="snapshots" />}
                <PanelBody className="p-2">
                  {failed(asset.refetch) ??
                    (!d ? (
                      <SkeletonRows rows={5} />
                    ) : d.snapshots.length === 0 ? (
                      <EmptyBlock label={`no snapshots yet — the collector adds ${coin} once it is held, watched or top-20 by OI`} />
                    ) : (
                      <AssetTimeline rows={rows} events={events} flowOk={flowOk} flowNote={flowNote} highlight={highlight} hot={hot} />
                    ))}
                </PanelBody>
              </Panel>
              <Panel>
                <PanelHeader title={`EVENTS · ${days}D`} />
                <PanelBody>
                  {!d ? (
                    asset.error || asset.offline ? null : <SkeletonRows rows={2} />
                  ) : events.length === 0 && upcoming.length === 0 ? (
                    <EmptyBlock label={`no events in ${DAYS_WORD[days]}`} />
                  ) : (
                    <EventList events={events} upcoming={upcoming} hot={hot} onHover={setHot} now={now} />
                  )}
                </PanelBody>
              </Panel>
            </div>
            <div className="lg:col-span-4 min-w-0">
              <Panel>
                <PanelHeader title="EXPOSURE">
                  {d && (
                    <span className="label">
                      {d.graph.edges.length} EDGES · {d.graph.paths.length} PATHS
                    </span>
                  )}
                </PanelHeader>
                <PanelBody className="px-3 pb-3">
                  {failed(asset.refetch) ?? (!d ? <SkeletonRows rows={2} /> : <ExposureGraph asset={coin} edges={d.graph.edges} paths={d.graph.paths} onChanged={asset.refetch} />)}
                </PanelBody>
              </Panel>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
