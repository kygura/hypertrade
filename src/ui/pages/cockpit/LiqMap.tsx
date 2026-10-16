import { useEffect, useMemo, useRef, useState } from 'react'
import { Bar, BarChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Badge, DataTable, EmptyBlock, ErrorBlock, OfflineBlock, Panel, PanelHeader, Segmented, SkeletonRows, StaleStrip, type Column } from '../../components'
import { fmtUsdCompact } from '../../components/branches/format'
import { fmtAge, fmtDur } from '../../components/strategy/format'
import { fmtPx } from '../../lib/desk'
import { platform, PLATFORM_POLL } from '../../lib/platformApi'
import { usePoll, type PollState } from '../../lib/poll'
import { bucketBounds, bucketIndex, type Cluster, type Coverage, type LiqBoardResponse, type LiqBucket, type LiqMap, type LiqMapHistory } from '../../../shared/platform'
import { alphaStep, cellRow, cellSide, coverageTreatment, denseBuckets, fmtSigned, p95, priceY, type CoverageTreatment } from './logic'

// LiqMapPanel (container) + LiqProfile / LiqHistory / CoverageLine / LiqBoard — DESIGN-terminal C4.
// PROFILE is Recharts (≤ 80 bars); HISTORY is one DPR-scaled <canvas>. Both
// sit on the same log price axis: profile bands are one per grid idx (dense),
// and the canvas maps idx → row with the same [lo, hi].

export type HistWindow = 6 | 24 | 72
const CHART_H = 280
const X_AXIS_H = 20
const LONG = 'var(--color-proj-line)'
const SHORT = 'var(--color-bench-btc)'

type PanelProps = {
  coin: string
  /** Picker options: the board's coins (top by OI). */
  coins: readonly string[]
  onCoin: (coin: string) => void
  /** From the board: how many coins the snapshot loop tracks and whether this one is among them; null before the board lands. */
  tracked: { count: number; has: boolean } | null
  wsMark: number | null
  window: HistWindow
  onWindow: (w: HistWindow) => void
  now: number
}

/** Container: polls the live map and its history (C8), renders LiqMapView. */
export function LiqMapPanel(props: PanelProps) {
  const { coin, window } = props
  const live = usePoll(() => platform.liqmap(coin), [coin], { intervalMs: 15_000, ...PLATFORM_POLL })
  const hist = usePoll(() => platform.history(coin, window), [coin, window], { intervalMs: 5 * 60_000, ...PLATFORM_POLL })
  return <LiqMapView {...props} live={live} hist={hist} />
}

type Polled<T> = Pick<PollState<T>, 'data' | 'loading' | 'offline' | 'error' | 'fetchedAt' | 'refetch'>

export function LiqMapView({
  coin,
  coins,
  onCoin,
  tracked,
  wsMark,
  window,
  onWindow,
  now,
  live,
  hist,
}: PanelProps & { live: Polled<LiqMap | null>; hist: Polled<LiqMapHistory> }) {
  const [view, setView] = useState<'profile' | 'history'>('profile')

  const data = live.data?.coin === coin ? live.data : null // null also = 503 no_mark → empty
  const mark = wsMark ?? data?.mark ?? null
  const dense = useMemo(() => (data ? denseBuckets(data.buckets, data.bucketBps) : []), [data])
  const axis = useMemo(() => {
    if (dense.length) return { lo: dense.at(-1)!.priceLo, hi: dense[0]!.priceHi }
    const marks = hist.data?.snapshots.map((s) => s.mark) ?? []
    return marks.length ? { lo: Math.min(...marks) * 0.9, hi: Math.max(...marks) * 1.1 } : null
  }, [dense, hist.data])
  const ageSec = data ? (now - Date.parse(data.ts)) / 1000 : 0

  let profile
  if (!data && live.loading && live.fetchedAt == null) profile = <SkeletonRows rows={6} />
  else if (!data && live.offline) profile = <OfflineBlock message={live.offline} onRetry={live.refetch} />
  else if (!data && live.error) profile = <ErrorBlock message={live.error} onRetry={live.refetch} />
  else if (!data || data.buckets.length === 0) profile = <EmptyBlock label={`no tracked positions on ${coin} yet — the crawler adds addresses as they trade`} />
  else profile = <LiqProfile buckets={dense} mark={mark!} coverage={data.coverage} coin={coin} />

  let history
  const h = hist.data?.coin === coin ? hist.data : null
  if (!h && hist.loading) history = <SkeletonRows rows={6} />
  else if (!h && hist.offline) history = <OfflineBlock message={hist.offline} onRetry={hist.refetch} />
  else if (!h && hist.error) history = <ErrorBlock message={hist.error} onRetry={hist.refetch} />
  else if ((!h || h.snapshots.length === 0) && tracked && !tracked.has)
    history = <EmptyBlock label={`history is kept for the top ${tracked.count} coins by OI — ${coin} is not one`} />
  else if (!h || h.snapshots.length === 0) history = <EmptyBlock label="no snapshots yet — history builds every 15 min" />
  else if (h.snapshots.length < 2) history = <EmptyBlock label={`history builds every 15 min — first snapshot ${fmtAge(h.snapshots[0]!.ts).toLowerCase()}`} />
  else if (!axis) history = <EmptyBlock label="history unavailable" />
  else history = <LiqHistory history={h} lo={axis.lo} hi={axis.hi} coin={coin} />

  const partial = data ? coverageTreatment(data.coverage.ratio) !== 'full' : false
  return (
    <Panel className="min-w-0">
      <PanelHeader title={`LIQUIDATIONS · ${coin}`}>
        <select aria-label="liquidation coin" value={coin} onChange={(e) => onCoin(e.target.value)} className="text-[10px] min-h-[var(--tap-min)] md:min-h-0">
          {(coins.includes(coin) ? coins : [coin, ...coins]).map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <Segmented<HistWindow>
          label="history window"
          size="sm"
          value={window}
          onChange={onWindow}
          options={[
            { value: 6, label: '6H' },
            { value: 24, label: '24H' },
            { value: 72, label: '72H' },
          ]}
        />
      </PanelHeader>
      {data && <CoverageLine coverage={data.coverage} />}
      {data && ageSec > 60 && <StaleStrip>liquidation map {Math.floor(ageSec / 60)}m old</StaleStrip>}
      {data && partial && (
        <p className="px-3 pt-1 text-[10px] text-amber">
          only {Math.round(data.coverage.ratio * 100)}% of open interest is mapped — missing clusters are likely
        </p>
      )}
      <div className="px-3 pt-2 xl:hidden">
        <Segmented
          label="liquidation view"
          size="sm"
          value={view}
          onChange={setView}
          options={[
            { value: 'profile', label: 'PROFILE' },
            { value: 'history', label: 'HISTORY' },
          ]}
        />
      </div>
      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_260px] gap-2 p-2">
        <div className={view === 'history' ? '' : 'hidden xl:block'}>{history}</div>
        <div className={view === 'profile' ? '' : 'hidden xl:block'}>{profile}</div>
      </div>
      {data && data.buckets.length > 0 && <Callouts clusters={data.nearestClusters} ratio={data.coverage.ratio} />}
    </Panel>
  )
}

const ageMin = (sec: number | null) => (sec == null ? '—' : fmtDur(sec))

export function CoverageLine({ coverage }: { coverage: Coverage }) {
  const t = coverageTreatment(coverage.ratio)
  const slowP90 = coverage.pollAgeP90Sec != null && coverage.pollAgeP90Sec > 30 * 60
  return (
    <div className={`flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-1.5 text-[10px] tabular border-b border-border-subtle ${t === 'full' ? 'text-text-secondary' : 'text-amber'}`}>
      <span>
        COVERAGE {Math.round(coverage.ratio * 100)}% OF OI · {coverage.addresses.toLocaleString()} ADDR · POLL p50 {ageMin(coverage.pollAgeP50Sec)}{' '}
        <span className={slowP90 ? 'text-amber' : undefined}>p90 {ageMin(coverage.pollAgeP90Sec)}</span>
      </span>
      {t !== 'full' && <Badge tone="amber">PARTIAL MAP</Badge>}
    </div>
  )
}

/** Server cluster (liqmap.aggregate) → `$6.1M` / `≥ $6.1M`, signed distance (long below mark), mid price. */
const clusterParts = (c: Cluster, side: 'long' | 'short', t: CoverageTreatment) => ({
  usd: `${t === 'partial' ? '≥ ' : ''}${fmtUsdCompact(c.notionalUsd)}`,
  dist: fmtSigned(side === 'long' ? -c.distancePct : c.distancePct, '%', 1),
  px: fmtPx((c.priceLo + c.priceHi) / 2),
})

function Callouts({ clusters, ratio }: { clusters: LiqMap['nearestClusters']; ratio: number }) {
  const t = coverageTreatment(ratio)
  if (t === 'none') return <p className="px-3 pb-2 text-[10px] text-text-secondary">too little coverage to name clusters</p>
  const line = (word: string, side: 'long' | 'short') => {
    const c = clusters[side]
    if (!c) return `${word} CLUSTER —`
    const p = clusterParts(c, side, t)
    return `${word} CLUSTER ${p.usd} @ ${p.px} · ${p.dist}`
  }
  return (
    <div className="flex flex-wrap gap-x-4 px-3 pb-2 text-[10px] tabular text-text-primary">
      <span>{line('SHORT', 'short')}</span>
      <span>{line('LONG', 'long')}</span>
    </div>
  )
}

// ─── Liquidation board (feed slot while the feed is empty; SPEC P3 gate amendment) ───

type BoardRow = LiqBoardResponse['rows'][number]

function ClusterCell({ c, side, coverage }: { c: Cluster | null; side: 'long' | 'short'; coverage: Coverage }) {
  const t = coverageTreatment(coverage.ratio)
  if (t === 'none') return <span className="text-text-secondary" title="too little coverage to name clusters">—</span>
  if (!c) return <span className="text-text-secondary">—</span>
  const p = clusterParts(c, side, t)
  return (
    <span title={`${side} liqs ${p.usd} @ ${p.px}`}>
      <span style={{ color: side === 'long' ? LONG : SHORT }}>{p.dist}</span> <span className="text-text-secondary">{p.usd}</span>
    </span>
  )
}

const BOARD_COLUMNS: Column<BoardRow>[] = [
  { key: 'coin', label: 'COIN', priority: 1, render: (r) => <span className="text-text-primary">{r.coin}</span> },
  { key: 'mark', label: 'MARK', priority: 3, align: 'right', render: (r) => fmtPx(r.mark) },
  { key: 'long', label: 'LONG LIQS', priority: 1, align: 'right', render: (r) => <ClusterCell c={r.nearestLong} side="long" coverage={r.coverage} /> },
  { key: 'short', label: 'SHORT LIQS', priority: 1, align: 'right', render: (r) => <ClusterCell c={r.nearestShort} side="short" coverage={r.coverage} /> },
  {
    key: 'cov',
    label: 'COV',
    priority: 2,
    align: 'right',
    render: (r) => {
      const t = coverageTreatment(r.coverage.ratio)
      return (
        <span className={t === 'full' ? 'text-text-secondary' : 'text-amber'} title={t === 'full' ? 'share of open interest mapped' : 'partial map — missing clusters are likely'}>
          {Math.round(r.coverage.ratio * 100)}%
        </span>
      )
    },
  },
]

export function LiqBoard({
  rows,
  loading,
  offline,
  error,
  selectedCoin,
  onSelect,
  onRetry,
}: {
  rows: BoardRow[] | null
  loading: boolean
  offline: string | null
  error: string | null
  selectedCoin: string
  onSelect: (coin: string) => void
  onRetry: () => void
}) {
  let body
  if (!rows && loading) body = <SkeletonRows rows={8} />
  else if (!rows && offline) body = <OfflineBlock message={offline} onRetry={onRetry} />
  else if (!rows && error) body = <ErrorBlock message={error} onRetry={onRetry} />
  else if (!rows || rows.length === 0) body = <EmptyBlock label="no marks yet — the board fills after the first scan" />
  else
    body = (
      <div data-feed>
        <DataTable columns={BOARD_COLUMNS} rows={rows} rowKey={(r) => r.coin} onRowClick={(r) => onSelect(r.coin)} isSelected={(r) => r.coin === selectedCoin} />
      </div>
    )
  return (
    <section aria-label="liquidation board" className="border-t border-border-subtle">
      <h3 className="label px-3 pt-2 pb-1">LIQUIDATION BOARD ─ BY NEAREST CLUSTER</h3>
      {body}
    </section>
  )
}

export function LiqProfile({ buckets, mark, coverage, coin }: { buckets: LiqBucket[]; mark: number; coverage: Coverage; coin: string }) {
  const rows = buckets.map((b) => ({ ...b, label: fmtPx((b.priceLo + b.priceHi) / 2) }))
  const markRow = rows.find((r) => mark >= r.priceLo && mark < r.priceHi) ?? null
  const max = Math.max(1, ...rows.map((r) => r.longUsd + r.shortUsd))
  return (
    <figure aria-label={`liquidation profile for ${coin}: long liquidations below mark ${fmtPx(mark)}, short above; ${Math.round(coverage.ratio * 100)}% of open interest mapped`}>
      <div className="flex justify-between h-4 text-[10px] label px-1">
        <span style={{ color: SHORT }}>▲ SHORT LIQS</span>
        <span style={{ color: LONG }}>▼ LONG LIQS</span>
      </div>
      <ResponsiveContainer width="100%" height={CHART_H}>
        <BarChart data={rows} layout="vertical" margin={{ top: 0, right: 0, bottom: 0, left: 0 }} barCategoryGap={0}>
          <XAxis
            type="number"
            domain={[0, max]}
            ticks={[0, max / 2, max]}
            height={X_AXIS_H}
            tickFormatter={(v: number) => fmtUsdCompact(v)}
            tick={{ fontSize: 10, fill: 'var(--color-text-secondary)' }}
            stroke="var(--color-border)"
          />
          <YAxis
            type="category"
            dataKey="label"
            orientation="right"
            width={56}
            interval={Math.max(0, Math.ceil(rows.length / 8) - 1)}
            tick={{ fontSize: 10, fill: 'var(--color-text-secondary)' }}
            stroke="var(--color-border)"
          />
          <Tooltip
            cursor={{ fill: 'var(--color-hover)' }}
            content={({ payload }) => {
              const r = payload?.[0]?.payload as (typeof rows)[number] | undefined
              if (!r) return null
              return (
                <div className="panel px-2 py-1 text-[10px] tabular">
                  {r.label} · long liqs {fmtUsdCompact(r.longUsd)} · short liqs {fmtUsdCompact(r.shortUsd)}
                </div>
              )
            }}
          />
          <Bar dataKey="longUsd" stackId="liq" fill={LONG} isAnimationActive={false} name="long liqs" />
          <Bar dataKey="shortUsd" stackId="liq" fill={SHORT} isAnimationActive={false} name="short liqs" />
          {markRow && (
            <ReferenceLine
              y={markRow.label}
              stroke="var(--color-equity)"
              strokeWidth={1}
              label={{ value: `MARK ${fmtPx(mark)}`, position: 'insideBottomRight', fontSize: 10, fill: 'var(--color-equity)' }}
            />
          )}
        </BarChart>
      </ResponsiveContainer>
    </figure>
  )
}

const hhmm = (ts: string) => new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })

export function LiqHistory({ history, lo, hi, coin }: { history: LiqMapHistory; lo: number; hi: number; coin: string }) {
  const wrap = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [width, setWidth] = useState(0)
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null)
  const snaps = useMemo(() => [...history.snapshots].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts)), [history])
  const plotH = CHART_H - X_AXIS_H
  const ref = useMemo(() => p95(snaps.flatMap((s) => s.buckets.map((c) => c.longUsd + c.shortUsd))), [snaps])

  useEffect(() => {
    const el = wrap.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e!.contentRect.width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const c = canvas.current
    if (!c || width === 0) return
    const dpr = globalThis.devicePixelRatio || 1
    c.width = width * dpr
    c.height = plotH * dpr
    const ctx = c.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, plotH)
    const css = getComputedStyle(c)
    const color = { long: css.getPropertyValue('--color-proj-line').trim() || '#5897d7', short: css.getPropertyValue('--color-bench-btc').trim() || '#efbb00' }
    const colW = width / snaps.length
    snaps.forEach((s, i) => {
      for (const cell of s.buckets) {
        const step = alphaStep(cell.longUsd + cell.shortUsd, ref)
        if (step === 0) continue
        const { y, h } = cellRow(cell.idx, history.bucketBps, lo, hi, plotH)
        if (y + h < 0 || y > plotH) continue
        ctx.globalAlpha = step / 5
        ctx.fillStyle = color[cellSide(cell, history.bucketBps, s.mark)]
        ctx.fillRect(i * colW, y, Math.ceil(colW), Math.max(1, h))
      }
    })
    ctx.globalAlpha = 1
    ctx.strokeStyle = css.getPropertyValue('--color-equity').trim() || '#fff'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    snaps.forEach((s, i) => {
      const y = priceY(s.mark, lo, hi, plotH)
      if (i === 0) ctx.moveTo(0, y)
      ctx.lineTo((i + 1) * colW, y)
    })
    ctx.stroke()
  }, [snaps, width, lo, hi, plotH, ref, history.bucketBps])

  const onPointer = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - r.left
    const y = e.clientY - r.top
    const s = snaps[Math.min(snaps.length - 1, Math.max(0, Math.floor((x / r.width) * snaps.length)))]
    if (!s) return
    const px = Math.exp(Math.log(hi) - (y / plotH) * (Math.log(hi) - Math.log(lo)))
    const cell = s.buckets.find((c) => c.idx === bucketIndex(px, history.bucketBps))
    const side = px < s.mark ? 'long' : 'short'
    const usd = cell ? (side === 'long' ? cell.longUsd : cell.shortUsd) : 0
    setTip({ x, y, text: `${hhmm(s.ts)} · ${fmtPx(px)} · ${side} liqs ${fmtUsdCompact(usd)}` })
  }

  const peak = useMemo(() => {
    let best: { usd: number; px: number; ts: string; side: string } | null = null
    for (const s of snaps)
      for (const c of s.buckets) {
        const usd = c.longUsd + c.shortUsd
        if (!best || usd > best.usd) {
          const b = bucketBounds(c.idx, history.bucketBps)
          best = { usd, px: (b.priceLo + b.priceHi) / 2, ts: s.ts, side: cellSide(c, history.bucketBps, s.mark) }
        }
      }
    return best
  }, [snaps, history.bucketBps])
  const summary =
    `liquidation history for ${coin}: ${snaps.length} snapshots from ${hhmm(snaps[0]!.ts)} to ${hhmm(snaps.at(-1)!.ts)}, price ${fmtPx(lo)} to ${fmtPx(hi)}` +
    (peak && peak.usd > 0 ? `; largest cell ${fmtUsdCompact(peak.usd)} ${peak.side} liqs near ${fmtPx(peak.px)} at ${hhmm(peak.ts)}` : '')
  const nLabels = Math.min(5, snaps.length)
  const labels = Array.from({ length: nLabels }, (_, k) => snaps[Math.round((k * (snaps.length - 1)) / Math.max(1, nLabels - 1))]!)

  return (
    <div ref={wrap} className="relative" style={{ height: CHART_H + 16 }}>
      <div className="flex justify-between h-4 text-[10px] label px-1" aria-hidden>
        <span>TIME × PRICE</span>
        <span>
          <span style={{ color: SHORT }}>■ SHORT LIQS</span> <span style={{ color: LONG }}>■ LONG LIQS</span>
        </span>
      </div>
      <canvas
        ref={canvas}
        role="img"
        aria-label={summary}
        style={{ width: '100%', height: plotH, display: 'block', touchAction: 'none' }}
        onPointerMove={onPointer}
        onPointerDown={onPointer}
        onPointerLeave={() => setTip(null)}
      />
      <div className="relative text-[10px] tabular text-text-secondary" style={{ height: X_AXIS_H }} aria-hidden>
        {labels.map((s, k) => (
          <span key={s.ts} className="absolute top-1" style={{ left: `${(k / Math.max(1, labels.length - 1)) * 100}%`, transform: `translateX(${k === 0 ? '0' : k === labels.length - 1 ? '-100%' : '-50%'})` }}>
            {hhmm(s.ts)}
          </span>
        ))}
      </div>
      {tip && (
        <div className="panel absolute px-2 py-1 text-[10px] tabular pointer-events-none whitespace-nowrap" style={{ left: Math.max(0, Math.min(tip.x + 8, width - 200)), top: Math.max(0, tip.y - 8) }}>
          {tip.text}
        </div>
      )}
    </div>
  )
}
