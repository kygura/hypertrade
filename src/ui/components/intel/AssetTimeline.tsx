import type { ReactElement } from 'react'
import { Bar, Cell, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { fmtPrice, fmtUsd } from '../../../shared/format'
import type { AssetEvent, FlowRow, HeatmapMetric, SnapshotRow } from '../../../shared/intel'
import { fmtUsdCompact } from '../branches/format'
import { fmtMdHm, fmtSigned } from './format'

// AssetTimeline — DESIGN-terminal §15.5. Stacked Recharts ComposedCharts
// sharing syncId="asset" (one crosshair across panes, synced by time value)
// and one margin + x domain so the axes align; only the bottom pane draws x
// ticks. Event markers on the PRICE pane only: observed gray, model
// (news alerts) info-blue; the hovered EventList row's marker turns
// text-primary. No animation, dark tooltip, 9px ticks.

export type Pane = 'price' | 'oi' | 'funding' | 'depth' | 'liqs'

export interface TimelineRow {
  t: number
  price?: number
  oi?: number | null
  /** Hourly funding in %. */
  funding?: number | null
  depth?: number | null
  bid2?: number | null
  ask2?: number | null
  bid1?: number | null
  ask1?: number | null
  spread?: number | null
  premium?: number | null
  basis?: number | null
  vol24h?: number | null
  liqs?: number
  ls?: number
}

const sum = (a: number | null, b: number | null) => (a == null || b == null ? null : a + b)

/** Snapshots and flow rows merged on one time axis, ascending. Liquidations = long + short per ts. */
export function timelineRows(snapshots: SnapshotRow[], flow: FlowRow[]): TimelineRow[] {
  const rows = new Map<number, TimelineRow>()
  const at = (t: number) => rows.get(t) ?? rows.set(t, { t }).get(t)!
  for (const s of snapshots) {
    Object.assign(at(Date.parse(s.ts)), {
      price: s.price,
      oi: s.oiUsd,
      funding: s.funding == null ? null : s.funding * 100,
      depth: sum(s.depthBid2, s.depthAsk2),
      bid2: s.depthBid2,
      ask2: s.depthAsk2,
      bid1: s.depthBid1,
      ask1: s.depthAsk1,
      spread: s.spreadBps,
      premium: s.premium,
      basis: s.basis,
      vol24h: s.vol24h,
    })
  }
  for (const f of flow) {
    const r = at(Date.parse(f.ts))
    if (f.metric === 'liq_long_usd' || f.metric === 'liq_short_usd') r.liqs = (r.liqs ?? 0) + f.value
    else if (f.metric === 'long_short_ratio') r.ls = f.value
  }
  return [...rows.values()].filter((r) => Number.isFinite(r.t)).sort((a, b) => a.t - b.t)
}

/** The pane a heatmap metric highlights on arrival (`?metric=`); tooltip-only metrics land on PRICE. */
export function paneOf(metric: string | null): Pane | null {
  switch (metric as HeatmapMetric | null) {
    case 'price':
    case 'basis':
    case 'premium':
    case 'vol24h':
      return 'price'
    case 'oi_usd':
      return 'oi'
    case 'funding':
      return 'funding'
    case 'depth_2':
    case 'spread_bps':
      return 'depth'
    case 'liq_usd':
    case 'long_short_ratio':
      return 'liqs'
    default:
      return null
  }
}

/** Model events (news alerts, research §16.4) are info-blue; detector hits, flips, crossings and catalysts are observed gray. */
export function markerStroke(e: Pick<AssetEvent, 'kind'>, hot: boolean): string {
  if (hot) return 'var(--color-text-primary)'
  return e.kind === 'alert' || e.kind === 'research' ? 'var(--color-info)' : 'var(--color-text-secondary)'
}

export const eventKey = (e: AssetEvent) => `${e.kind}:${e.ts}:${e.title}`

const MARGIN = { top: 4, right: 8, left: 0, bottom: 0 }
/** recharts 2.15 treats an explicit `yAxisId={undefined}` as a real id and throws; omit the prop instead. */
export const yAxisIdProp = (id?: string) => (id ? { yAxisId: id } : {})

const TICK = { fontSize: 9, fill: 'var(--color-text-secondary)' }
const pct = (v: number | null | undefined, d = 4) => (v == null ? '—' : `${fmtSigned(v, d)}%`)
const usd = (v: number | null | undefined) => (v == null ? '—' : fmtUsd(v, { compact: true }))

const LEGEND: { pane: Pane; label: string; color: string }[] = [
  { pane: 'price', label: 'PRICE', color: 'var(--color-equity)' },
  { pane: 'oi', label: 'OI', color: 'var(--color-info)' },
  { pane: 'funding', label: 'FUND', color: 'var(--color-green)' },
  { pane: 'depth', label: 'DEPTH ±2%', color: 'var(--color-bench-usdc)' },
  { pane: 'liqs', label: 'LIQS · L/S', color: 'var(--color-bench-usdc)' },
]

function TipBox({ active, payload, lines }: { active?: boolean; payload?: { payload: TimelineRow }[]; lines: (r: TimelineRow) => [string, string][] }) {
  const r = payload?.[0]?.payload
  if (!active || !r) return null
  return (
    <div className="bg-elevated border border-border px-2 py-1 text-sm tabular text-text-primary">
      <div className="text-text-secondary">{fmtMdHm(new Date(r.t).toISOString())} UTC</div>
      {lines(r).map(([k, v]) => (
        <div key={k}>
          <span className="text-text-secondary">{k}</span> {v}
        </div>
      ))}
    </div>
  )
}

function PaneBox({ pane, highlight, cls, children }: { pane: Pane; highlight: Pane | null; cls: string; children: ReactElement }) {
  return (
    <div className={`${cls} ${highlight === pane ? 'shadow-[inset_2px_0_0_var(--color-red-accent)]' : ''}`} data-pane={pane}>
      <ResponsiveContainer width="100%" height="100%">
        {children}
      </ResponsiveContainer>
    </div>
  )
}

export function AssetTimeline({
  rows,
  events,
  flowOk,
  flowNote,
  highlight,
  hot,
}: {
  rows: TimelineRow[]
  events: AssetEvent[]
  /** false → LIQS pane omitted, `flowNote` in its place. */
  flowOk: boolean
  flowNote: string
  highlight: Pane | null
  /** Key of the hovered EventList row. */
  hot: string | null
}) {
  const domain: [number, number] = [rows[0]?.t ?? 0, rows.at(-1)?.t ?? 1]
  const markers = events.filter((e) => {
    const t = Date.parse(e.ts)
    return t >= domain[0] && t <= domain[1]
  })
  const x = (bottom: boolean) => (
    <XAxis
      dataKey="t"
      type="number"
      scale="time"
      domain={domain}
      hide={!bottom}
      tickFormatter={(t: number) => fmtMdHm(new Date(t).toISOString())}
      tick={TICK}
      stroke="var(--color-border)"
      interval="preserveStartEnd"
      minTickGap={48}
    />
  )
  const y = (fmt: (v: number) => string, id?: string) => (
    <YAxis {...yAxisIdProp(id)} tickFormatter={fmt} tick={TICK} stroke="var(--color-border)" width={44} />
  )
  const chart = { data: rows, syncId: 'asset', syncMethod: 'value' as const, margin: MARGIN }
  const small = 'h-[90px] lg:h-[120px]'

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-3 text-xs uppercase text-text-secondary">
        {LEGEND.filter((l) => flowOk || l.pane !== 'liqs').map((l) => (
          <span key={l.pane} className="inline-flex items-center gap-1">
            <span className="inline-block w-2 h-2" style={{ background: l.color }} />
            {l.label}
          </span>
        ))}
      </div>
      <PaneBox pane="price" highlight={highlight} cls="h-[160px] lg:h-[220px]">
        <ComposedChart {...chart}>
          {x(false)}
          {y(fmtUsdCompact)}
          <Tooltip
            content={
              <TipBox
                lines={(r) => [
                  ['price', r.price == null ? '—' : fmtPrice(r.price)],
                  ['premium', pct(r.premium == null ? null : r.premium * 100)],
                  ['basis', pct(r.basis == null ? null : r.basis * 100)],
                  ['vol 24h', usd(r.vol24h)],
                ]}
              />
            }
          />
          <Line dataKey="price" stroke="var(--color-equity)" strokeWidth={1} dot={false} isAnimationActive={false} connectNulls />
          {markers.map((e) => {
            const k = eventKey(e)
            return <ReferenceLine key={k} x={Date.parse(e.ts)} stroke={markerStroke(e, hot === k)} strokeDasharray="3 3" />
          })}
        </ComposedChart>
      </PaneBox>
      <PaneBox pane="oi" highlight={highlight} cls={small}>
        <ComposedChart {...chart}>
          {x(false)}
          {y(fmtUsdCompact)}
          <Tooltip content={<TipBox lines={(r) => [['OI', usd(r.oi)]]} />} />
          <Line dataKey="oi" stroke="var(--color-info)" strokeWidth={1} dot={false} isAnimationActive={false} connectNulls />
        </ComposedChart>
      </PaneBox>
      <PaneBox pane="funding" highlight={highlight} cls={small}>
        <ComposedChart {...chart}>
          {x(false)}
          {y((v) => `${v.toFixed(3)}%`)}
          <Tooltip content={<TipBox lines={(r) => [['funding /h', pct(r.funding)]]} />} />
          <ReferenceLine y={0} stroke="var(--color-border)" />
          <Bar dataKey="funding" isAnimationActive={false}>
            {rows.map((r) => (
              <Cell key={r.t} fill={(r.funding ?? 0) >= 0 ? 'var(--color-green)' : 'var(--color-red)'} fillOpacity={0.6} />
            ))}
          </Bar>
        </ComposedChart>
      </PaneBox>
      <PaneBox pane="depth" highlight={highlight} cls={small}>
        <ComposedChart {...chart}>
          {x(!flowOk)}
          {y(fmtUsdCompact)}
          <Tooltip
            content={
              <TipBox
                lines={(r) => [
                  ['±2% bid / ask', `${usd(r.bid2)} / ${usd(r.ask2)}`],
                  ['±1% bid / ask', `${usd(r.bid1)} / ${usd(r.ask1)}`],
                  ['spread', r.spread == null ? '—' : `${r.spread.toFixed(1)} bp`],
                ]}
              />
            }
          />
          <Line dataKey="depth" stroke="var(--color-bench-usdc)" strokeWidth={1} dot={false} isAnimationActive={false} connectNulls />
        </ComposedChart>
      </PaneBox>
      {flowOk ? (
        <PaneBox pane="liqs" highlight={highlight} cls={small}>
          <ComposedChart {...chart}>
            {x(true)}
            {y(fmtUsdCompact, 'usd')}
            {/* ponytail: L/S scale is hidden so every pane keeps the same plot width (x axes align); its value is in the tooltip. */}
            <YAxis yAxisId="ls" orientation="right" hide />
            <Tooltip
              content={
                <TipBox
                  lines={(r) => [
                    ['liqs', usd(r.liqs)],
                    ['L/S', r.ls == null ? '—' : r.ls.toFixed(2)],
                  ]}
                />
              }
            />
            <Bar yAxisId="usd" dataKey="liqs" fill="var(--color-bench-usdc)" fillOpacity={0.6} isAnimationActive={false} />
            <Line yAxisId="ls" dataKey="ls" stroke="var(--color-equity)" strokeWidth={1} dot={false} isAnimationActive={false} connectNulls />
          </ComposedChart>
        </PaneBox>
      ) : (
        <p className="text-xs text-text-secondary px-1">{flowNote}</p>
      )}
    </div>
  )
}
