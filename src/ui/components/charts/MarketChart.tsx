import { useEffect, useMemo, useRef, useState } from 'react'
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  PriceScaleMode,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type MouseEventParams,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts'
import { fmtPct, fmtPrice, fmtUsd } from '../../../shared/format'
import { fundingApr, type ChartBar } from '../../../shared/market'
import { TIMEFRAMES, type Timeframe } from '../../../shared/timeframes'
import { useCandlePages } from '../../lib/candles'
import { useHlReconnect, useHlSubscription, type WsCandle } from '../../lib/hlWs'
import { useTheme } from '../../themes/registry'
import { Segmented } from '../Segmented'
import { EmptyBlock, ErrorBlock, OfflineBlock, SkeletonRows } from '../state'

// MarketChart — DESIGN.md §9.4. TradingView lightweight-charts (canvas), the
// one chart that isn't Recharts: it has to hold tens of thousands of bars,
// pan/zoom, and stack panes on one time axis. Panes: price + volume, funding
// APR, open interest, premium. Scrolling left pages in older history (the
// server backfills it: HL, then Binance, then Bitstamp); the newest bar
// streams live over Hyperliquid's websocket.

// Minutes stay lowercase so 1m and 1M (month) never read alike.
const TF_LABEL: Record<Timeframe, string> = { '1m': '1m', '5m': '5m', '15m': '15m', '1h': '1H', '4h': '4H', '1d': '1D', '1w': '1W', '1M': '1M' }
// Inline style: the theme uppercases control labels, which would make 1m and 1M identical.
const TF_OPTIONS = TIMEFRAMES.map((v) => ({ value: v, label: <span style={{ textTransform: 'none' }}>{TF_LABEL[v]}</span> }))

type Overlay = 'vol' | 'funding' | 'oi' | 'premium'
const OVERLAYS: { id: Overlay; label: string; title: string }[] = [
  { id: 'vol', label: 'VOL', title: 'Volume (base units)' },
  { id: 'funding', label: 'FUND', title: 'Funding, annualized (mean hourly rate per bar)' },
  { id: 'oi', label: 'OI', title: 'Open interest, USD (15-minute snapshots)' },
  { id: 'premium', label: 'PREM', title: 'Mark vs oracle premium, basis points' },
]
const DEFAULT_OVERLAYS: Record<Overlay, boolean> = { vol: true, funding: true, oi: true, premium: false }
const PREFS_KEY = 'hypertrade.chart.overlays'

const SRC_LABEL: Record<string, string> = { hl: 'HL', binance: 'BINANCE', bitstamp: 'BITSTAMP' }
/** Start loading the previous page when fewer than this many bars remain off the left edge. */
const PREFETCH_BARS = 150
/** Bars in view on first load. */
const INITIAL_VIEW = 180

function css(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

/** Scales a hex or rgb(a) color's opacity by `a` (theme tokens may already carry alpha). */
function alpha(color: string, a: number): string {
  if (color.startsWith('#') && color.length === 7) {
    const n = parseInt(color.slice(1), 16)
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`
  }
  const m = /rgba?\(([^)]+)\)/.exec(color)
  if (m) {
    const [r, g, b, a0] = m[1]!.split(',').map((x) => x.trim())
    return `rgba(${r},${g},${b},${(a0 == null ? 1 : Number(a0)) * a})`
  }
  return color
}

function loadPrefs(): Record<Overlay, boolean> {
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    return raw ? { ...DEFAULT_OVERLAYS, ...(JSON.parse(raw) as Partial<Record<Overlay, boolean>>) } : DEFAULT_OVERLAYS
  } catch {
    return DEFAULT_OVERLAYS
  }
}

function savePrefs(p: Record<Overlay, boolean>) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p))
  } catch {
    // blocked storage: prefs last for this visit
  }
}

const sec = (ms: number) => (ms / 1000) as UTCTimestamp

/** Decimals that resolve a price's last meaningful digits (HL quotes 5 significant figures). */
function precisionFor(price: number): number {
  if (!(price > 0)) return 2
  return Math.min(10, Math.max(0, 4 - Math.floor(Math.log10(price))))
}

function fmtCompact(n: number): string {
  const a = Math.abs(n)
  if (a >= 1e9) return (n / 1e9).toFixed(2) + 'B'
  if (a >= 1e6) return (n / 1e6).toFixed(2) + 'M'
  if (a >= 1e3) return (n / 1e3).toFixed(2) + 'K'
  return n.toFixed(2)
}

const fmtBp = (frac: number) => `${(frac * 1e4).toFixed(1)}bp`

function fmtBarTime(ms: number, tf: Timeframe): string {
  const iso = new Date(ms).toISOString()
  if (tf === '1M') return iso.slice(0, 7)
  if (tf === '1d' || tf === '1w') return iso.slice(0, 10)
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`
}

/** Index of the bar opening at `ms` (bars ascending), or -1. */
function findBar(bars: ChartBar[], ms: number): number {
  let lo = 0
  let hi = bars.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const t = bars[mid]!.t
    if (t === ms) return mid
    if (t < ms) lo = mid + 1
    else hi = mid - 1
  }
  return -1
}

/** Where the history switches venue, oldest first. */
function sourceSpans(bars: ChartBar[]): { src: string; from: number }[] {
  const out: { src: string; from: number }[] = []
  for (const b of bars) if (out.length === 0 || out[out.length - 1]!.src !== b.src) out.push({ src: b.src, from: b.t })
  return out
}

interface Series {
  candle: ISeriesApi<'Candlestick'>
  markers: ISeriesMarkersPluginApi<Time>
  vol?: ISeriesApi<'Histogram'>
  funding?: ISeriesApi<'Histogram'>
  oi?: ISeriesApi<'Line'>
  premium?: ISeriesApi<'Line'>
  colors: { up: string; down: string; muted: string }
}

export function MarketChart({ coin, tf, onTfChange }: { coin: string; tf: Timeframe; onTfChange: (tf: Timeframe) => void }) {
  const data = useCandlePages(coin, tf)
  const [theme] = useTheme()
  const [overlays, setOverlays] = useState(loadPrefs)
  const [logScale, setLogScale] = useState(false)
  const [hover, setHover] = useState<number | null>(null)

  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<Series | null>(null)
  const [chartVersion, setChartVersion] = useState(0)
  const pushed = useRef<{ version: number; generation: number; first: number; last: number; len: number } | null>(null)
  /** Last visible time range, so a rebuild (theme, pane toggle) keeps the view. */
  const view = useRef<{ generation: number; range: { from: Time; to: Time } } | null>(null)

  // Latest values for imperative callbacks.
  const barsRef = useRef(data.bars)
  barsRef.current = data.bars
  const loadOlderRef = useRef(data.loadOlder)
  loadOlderRef.current = data.loadOlder
  const hasMoreRef = useRef(data.hasMore)
  hasMoreRef.current = data.hasMore

  const hasBars = data.bars.length > 0
  const overlayKey = OVERLAYS.map((o) => (overlays[o.id] ? o.id : '')).join(',')
  const lastPrice = data.bars[data.bars.length - 1]?.c ?? 0
  const precision = precisionFor(lastPrice)

  // ── chart lifecycle: rebuilt when the theme or the pane set changes ──
  useEffect(() => {
    const el = containerRef.current
    if (!el || !hasBars) return
    const text = css('--color-text-secondary', '#928d86')
    const border = css('--color-border', 'rgba(255,255,255,0.08)')
    const up = css('--color-green', '#38a67c')
    const down = css('--color-red', '#bc263e')
    const info = css('--color-info', '#6ea8d8')
    const amber = css('--color-amber', '#ffb800')
    const font = css('--font-mono', 'ui-monospace, monospace')

    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: text,
        fontFamily: font,
        fontSize: 10,
        attributionLogo: false,
        panes: { separatorColor: border, separatorHoverColor: alpha(text, 0.2), enableResize: true },
      },
      grid: { vertLines: { color: alpha(border, 0.6) }, horzLines: { color: alpha(border, 0.6) } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: border },
      timeScale: {
        borderColor: border,
        timeVisible: tf !== '1d' && tf !== '1w' && tf !== '1M',
        secondsVisible: false,
        rightOffset: 6,
        minBarSpacing: 0.2,
      },
      localization: { timeFormatter: (t: Time) => fmtBarTime((t as number) * 1000, tf) },
    })

    const candle = chart.addSeries(CandlestickSeries, {
      upColor: up,
      downColor: down,
      wickUpColor: up,
      wickDownColor: down,
      borderVisible: false,
    })
    const series: Series = { candle, markers: createSeriesMarkers(candle, []), colors: { up, down, muted: text } }

    if (overlays.vol) {
      series.vol = chart.addSeries(HistogramSeries, {
        priceScaleId: 'vol',
        priceFormat: { type: 'custom', formatter: fmtCompact, minMove: 1e-8 },
        lastValueVisible: false,
        priceLineVisible: false,
      })
      chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } })
      chart.priceScale('right').applyOptions({ scaleMargins: { top: 0.06, bottom: 0.2 } })
    }

    let pane = 1
    const paneFactors: number[] = [3]
    if (overlays.funding) {
      series.funding = chart.addSeries(
        HistogramSeries,
        {
          title: 'FUND APR',
          priceLineVisible: false,
          priceFormat: { type: 'custom', formatter: (v: number) => fmtPct(v, { decimals: 1 }), minMove: 0.0001 },
        },
        pane++,
      )
      series.funding.createPriceLine({ price: 0, color: border, lineWidth: 1, lineStyle: 0, axisLabelVisible: false, title: '' })
      paneFactors.push(1)
    }
    if (overlays.oi) {
      series.oi = chart.addSeries(
        LineSeries,
        {
          title: 'OI',
          color: info,
          lineWidth: 1,
          priceLineVisible: false,
          crosshairMarkerRadius: 2,
          priceFormat: { type: 'custom', formatter: (v: number) => fmtUsd(v, { compact: true }), minMove: 1 },
        },
        pane++,
      )
      paneFactors.push(1)
    }
    if (overlays.premium) {
      series.premium = chart.addSeries(
        LineSeries,
        {
          title: 'PREM',
          color: amber,
          lineWidth: 1,
          priceLineVisible: false,
          crosshairMarkerRadius: 2,
          priceFormat: { type: 'custom', formatter: fmtBp, minMove: 0.00001 },
        },
        pane++,
      )
      series.premium.createPriceLine({ price: 0, color: border, lineWidth: 1, lineStyle: 0, axisLabelVisible: false, title: '' })
      paneFactors.push(1)
    }
    chart.panes().forEach((p, i) => p.setStretchFactor(paneFactors[i] ?? 1))

    chartRef.current = chart
    seriesRef.current = series
    pushed.current = null
    setChartVersion((v) => v + 1)

    const onCrosshair = (param: MouseEventParams) => {
      setHover(param.time == null ? null : (param.time as number) * 1000)
    }
    chart.subscribeCrosshairMove(onCrosshair)

    // Page in older history as the left edge approaches.
    const onRange = (range: { from: number; to: number } | null) => {
      const t = chart.timeScale().getVisibleRange()
      if (t && pushed.current) view.current = { generation: pushed.current.generation, range: t }
      if (range && range.from < PREFETCH_BARS && hasMoreRef.current) loadOlderRef.current()
    }
    chart.timeScale().subscribeVisibleLogicalRangeChange(onRange)

    return () => {
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRange)
      chart.unsubscribeCrosshairMove(onCrosshair)
      chart.remove()
      chartRef.current = null
      seriesRef.current = null
    }
    // tf is read for axis formatting; a tf change also swaps the data generation.
  }, [theme, overlayKey, hasBars, tf]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    chartRef.current?.priceScale('right').applyOptions({ mode: logScale ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal })
  }, [logScale, chartVersion])

  useEffect(() => {
    seriesRef.current?.candle.applyOptions({ priceFormat: { type: 'price', precision, minMove: 1 / 10 ** precision } })
  }, [precision, chartVersion])

  // ── data: full set on replace/prepend, incremental update for the live bar ──
  useEffect(() => {
    const chart = chartRef.current
    const s = seriesRef.current
    const bars = data.bars
    if (!chart || !s || bars.length === 0) return
    const prev = pushed.current
    const first = bars[0]!.t
    const last = bars[bars.length - 1]!.t
    const volColor = (b: ChartBar) => alpha(b.c >= b.o ? s.colors.up : s.colors.down, 0.35)
    const fundColor = (v: number) => alpha(v >= 0 ? s.colors.up : s.colors.down, 0.6)

    const liveOnly =
      prev != null &&
      prev.version === chartVersion &&
      prev.generation === data.generation &&
      prev.first === first &&
      (prev.len === bars.length || (prev.len + 1 === bars.length && prev.last < last))

    if (liveOnly) {
      const b = bars[bars.length - 1]!
      s.candle.update({ time: sec(b.t), open: b.o, high: b.h, low: b.l, close: b.c })
      s.vol?.update({ time: sec(b.t), value: b.v, color: volColor(b) })
    } else {
      const ts = chart.timeScale()
      const keep =
        prev && prev.version === chartVersion && prev.generation === data.generation
          ? ts.getVisibleRange()
          : view.current?.generation === data.generation
            ? view.current.range
            : null
      s.candle.setData(bars.map((b) => ({ time: sec(b.t), open: b.o, high: b.h, low: b.l, close: b.c })))
      s.vol?.setData(bars.map((b) => ({ time: sec(b.t), value: b.v, color: volColor(b) })))
      s.funding?.setData(
        bars.map((b) => (b.f == null ? { time: sec(b.t) } : { time: sec(b.t), value: fundingApr(b.f), color: fundColor(b.f) })),
      )
      s.oi?.setData(bars.map((b) => (b.oi == null ? { time: sec(b.t) } : { time: sec(b.t), value: b.oi })))
      s.premium?.setData(bars.map((b) => (b.p == null ? { time: sec(b.t) } : { time: sec(b.t), value: b.p })))

      const markers: SeriesMarker<Time>[] = sourceSpans(bars)
        .filter((span, i) => i > 0 || span.src !== 'hl')
        .map((span) => ({ time: sec(span.from), position: 'belowBar', shape: 'arrowUp', color: s.colors.muted, text: SRC_LABEL[span.src] ?? span.src }))
      s.markers.setMarkers(markers)

      if (keep) {
        ts.setVisibleRange(keep)
      } else {
        ts.setVisibleLogicalRange({ from: Math.max(0, bars.length - INITIAL_VIEW), to: bars.length + 6 })
      }
      // A short page can leave the view still at the edge: keep paging.
      const range = ts.getVisibleLogicalRange()
      if (range && range.from < PREFETCH_BARS && data.hasMore) queueMicrotask(() => loadOlderRef.current())
    }
    pushed.current = { version: chartVersion, generation: data.generation, first, last, len: bars.length }
  }, [data.bars, data.generation, data.hasMore, chartVersion])

  // ── live: newest bar over the websocket; refetch the head after a drop ──
  useHlSubscription<WsCandle>(coin ? { type: 'candle', coin, interval: tf } : null, (c) => {
    data.applyLive({ t: c.t, o: Number(c.o), h: Number(c.h), l: Number(c.l), c: Number(c.c), v: Number(c.v) })
  })
  useHlReconnect(data.refreshHead)

  const legendBar = useMemo(() => {
    const bars = data.bars
    if (bars.length === 0) return null
    const i = hover != null ? findBar(bars, hover) : -1
    const idx = i >= 0 ? i : bars.length - 1
    return { bar: bars[idx]!, prev: idx > 0 ? bars[idx - 1]! : null }
  }, [data.bars, hover])

  const spans = useMemo(() => sourceSpans(data.bars), [data.bars])

  const toggle = (id: Overlay) => {
    const next = { ...overlays, [id]: !overlays[id] }
    setOverlays(next)
    savePrefs(next)
  }

  return (
    <div className="flex flex-col">
      <div className="panel-header flex-shrink-0 flex-wrap gap-2">
        <span className="panel-title">CHART</span>
        <div className="flex flex-wrap items-center gap-2">
          <Segmented label="timeframe" options={TF_OPTIONS} value={tf} onChange={onTfChange} />
          <div role="group" aria-label="chart panes" className="seg seg--sm">
            {OVERLAYS.map((o) => (
              <button
                key={o.id}
                type="button"
                role="checkbox"
                aria-checked={overlays[o.id]}
                title={o.title}
                onClick={() => toggle(o.id)}
                className="seg-item"
              >
                {o.label}
              </button>
            ))}
            <button
              type="button"
              role="checkbox"
              aria-checked={logScale}
              title="Logarithmic price scale"
              onClick={() => setLogScale((v) => !v)}
              className="seg-item"
            >
              LOG
            </button>
          </div>
        </div>
      </div>

      {data.offline && !hasBars ? (
        <OfflineBlock onRetry={data.reload} />
      ) : data.error && !hasBars ? (
        <ErrorBlock message={data.error} onRetry={data.reload} />
      ) : data.loading && !hasBars ? (
        <div className="flex flex-col gap-2">
          <SkeletonRows />
          <span className="text-[10px] text-text-secondary text-center pulse-label">backfilling candles…</span>
        </div>
      ) : !hasBars ? (
        <EmptyBlock label={data.syncError ? `no candle data — ${data.syncError}` : 'no candle data'} />
      ) : (
        <>
          {legendBar && <Legend coin={coin} tf={tf} {...legendBar} overlays={overlays} />}
          <div className="relative">
            <div
              ref={containerRef}
              className="w-full"
              style={{ height: chartHeight(overlays) }}
              role="img"
              aria-label={`${coin} ${tf} price chart with ${OVERLAYS.filter((o) => overlays[o.id]).map((o) => o.title).join(', ')}`}
            />
            {data.loadingOlder && (
              <span className="absolute left-2 top-1 text-[10px] text-text-secondary pulse-label">loading history…</span>
            )}
          </div>
          <Footnote spans={spans} hasMore={data.hasMore} funding={data.funding} oi={data.oi} syncError={data.syncError} overlays={overlays} />
        </>
      )}
    </div>
  )
}

function chartHeight(o: Record<Overlay, boolean>): string {
  const panes = (o.funding ? 1 : 0) + (o.oi ? 1 : 0) + (o.premium ? 1 : 0)
  // DESIGN.md §4.5: price area 240px mobile / 340px desktop, plus each pane.
  return `calc(${typeof window !== 'undefined' && window.innerWidth >= 1024 ? 340 : 240}px + ${panes} * 96px)`
}

function Legend({
  coin,
  tf,
  bar,
  prev,
  overlays,
}: {
  coin: string
  tf: Timeframe
  bar: ChartBar
  prev: ChartBar | null
  overlays: Record<Overlay, boolean>
}) {
  const change = prev && prev.c > 0 ? bar.c / prev.c - 1 : bar.o > 0 ? bar.c / bar.o - 1 : 0
  const tone = change > 0 ? 'text-green' : change < 0 ? 'text-red-text' : 'text-text-secondary'
  const cell = (label: string, value: string, cls = 'text-text-primary') => (
    <span className="whitespace-nowrap">
      <span className="text-text-secondary">{label} </span>
      <span className={cls}>{value}</span>
    </span>
  )
  return (
    <div className="px-2 pt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] tabular">
      <span className="text-text-secondary whitespace-nowrap">
        {coin}-PERP · {TF_LABEL[tf]} · {fmtBarTime(bar.t, tf)} UTC
      </span>
      {cell('O', fmtPrice(bar.o))}
      {cell('H', fmtPrice(bar.h))}
      {cell('L', fmtPrice(bar.l))}
      {cell('C', fmtPrice(bar.c), tone)}
      {cell('Δ', fmtPct(change, { sign: true }), tone)}
      {overlays.vol && cell('V', fmtCompact(bar.v))}
      {overlays.funding && cell('FUND', bar.f == null ? '--' : `${fmtPct(fundingApr(bar.f), { decimals: 1, sign: true })} apr`)}
      {overlays.oi && cell('OI', bar.oi == null ? '--' : fmtUsd(bar.oi, { compact: true }))}
      {overlays.premium && cell('PREM', bar.p == null ? '--' : fmtBp(bar.p))}
      {bar.src !== 'hl' && <span className="text-text-secondary whitespace-nowrap">SRC {SRC_LABEL[bar.src] ?? bar.src}</span>}
    </div>
  )
}

function Footnote({
  spans,
  hasMore,
  funding,
  oi,
  syncError,
  overlays,
}: {
  spans: { src: string; from: number }[]
  hasMore: boolean
  funding: { from: number | null; complete: boolean } | null
  oi: { from: number | null } | null
  syncError: string | null
  overlays: Record<Overlay, boolean>
}) {
  const date = (ms: number) => new Date(ms).toISOString().slice(0, 10)
  const parts: string[] = []
  parts.push(spans.map((s) => `${SRC_LABEL[s.src] ?? s.src} ${date(s.from)}`).join(' → ') + (hasMore ? ' · scroll left for more' : ' · full history'))
  if (overlays.funding || overlays.premium) {
    parts.push(
      funding?.from != null
        ? `funding since ${date(funding.from)}${funding.complete ? ' (listing)' : ', older syncing'}`
        : 'funding syncing',
    )
  }
  if (overlays.oi) {
    parts.push(oi?.from != null ? `OI snapshots from ${date(oi.from)} (every 15m)` : 'no OI snapshots in view — collected every 15m for tracked coins')
  }
  return (
    <div className="px-2 py-1.5 border-t border-border text-[10px] text-text-secondary flex flex-wrap gap-x-3 gap-y-0.5">
      {parts.map((p) => (
        <span key={p}>{p}</span>
      ))}
      {syncError && <span className="text-amber">sync: {syncError}</span>}
    </div>
  )
}
