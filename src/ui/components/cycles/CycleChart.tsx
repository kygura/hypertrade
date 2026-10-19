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
import { fmtPct } from '../../../shared/format'
import type { CycleForecast } from '../../../shared/cycleForecast'
import { CYCLE_PHASES, DAY_MS, weekStart, type CycleBar, type CyclePhase } from '../../../shared/cycles'
import { useTheme } from '../../themes/registry'
import { Segmented } from '../Segmented'
import { alpha, blend, css, fmtDay, fmtMonth, fmtUsdPx, PHASE_LABEL, PHASE_VAR } from './format'

// CycleChart — the hl-cycles HTF chart (docs/design/README.md §9.4 canvas chart family):
// BTC daily/weekly candles on a log scale over phase-coloured bands, SMA200,
// halvings and past bull-run onsets. Past the last bar it draws the forecast:
// the pooled onset range and its core (interquartile) window in projection
// blue, then the estimated top window in the euphoria colour.

type Range = 'all' | 'cycle'
const RANGE_OPTIONS = [
  { value: 'all' as const, label: 'ALL', title: 'Full history from 2011' },
  { value: 'cycle' as const, label: 'CYCLE', title: 'Since the last cycle top, through the projection' },
]
const TF_OPTIONS = [
  { value: '1d' as const, label: '1D' },
  { value: '1w' as const, label: '1W' },
]

const sec = (ms: number) => Math.floor(ms / 1000) as UTCTimestamp

type Series = {
  candle: ISeriesApi<'Candlestick'>
  sma: ISeriesApi<'Line'>
  bands: ISeriesApi<'Histogram'>
  proj: ISeriesApi<'Histogram'>
  candleMarkers: ISeriesMarkersPluginApi<Time>
  projMarkers: ISeriesMarkersPluginApi<Time>
}

/** Which projected window a future day falls in, most specific first. */
function windowAt(t: number, f: CycleForecast): 'core' | 'top' | 'range' | 'topRange' | null {
  const o = f.onset
  const p = f.top
  if (o && t >= o.p25 && t <= o.p75) return 'core'
  if (p && t >= p.p25 && t <= p.p75) return 'top'
  if (o && t >= o.min && t <= o.max) return 'range'
  if (p && t >= p.min && t <= p.max) return 'topRange'
  return null
}

const WINDOW_LABEL = {
  core: 'core run-start window (middle half of estimates)',
  range: 'run-start range (all estimates)',
  top: 'estimated cycle-top window',
  topRange: 'cycle-top range',
} as const

export function CycleChart({
  bars,
  halvings,
  nextHalving,
  forecast,
  tf,
  onTfChange,
}: {
  bars: CycleBar[]
  halvings: number[]
  nextHalving: number
  forecast: CycleForecast
  tf: '1d' | '1w'
  onTfChange: (tf: '1d' | '1w') => void
}) {
  const [theme] = useTheme()
  const [range, setRange] = useState<Range>('all')
  const [showProj, setShowProj] = useState(true)
  const [hoverT, setHoverT] = useState<number | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<Series | null>(null)
  const [version, setVersion] = useState(0)

  const byTime = useMemo(() => new Map(bars.map((b) => [sec(b.t), b])), [bars])
  const step = tf === '1w' ? 7 * DAY_MS : DAY_MS
  const last = bars[bars.length - 1]
  const projEnd = Math.max(forecast.top?.max ?? 0, forecast.onset?.max ?? 0, nextHalving) + 60 * DAY_MS

  // ── chart lifecycle: rebuilt on theme change so canvas colours follow tokens ──
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const text = css('--color-text-secondary', '#928d86')
    const border = css('--color-border', 'rgba(255,255,255,0.08)')
    const up = css('--color-green', '#38a67c')
    const down = css('--color-red', '#bc263e')
    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: text,
        fontFamily: css('--font-mono', 'ui-monospace, monospace'),
        fontSize: 10,
        attributionLogo: false,
      },
      grid: { vertLines: { color: alpha(border, 0.6) }, horzLines: { color: alpha(border, 0.6) } },
      crosshair: { mode: CrosshairMode.Normal },
      // entireTextOnly: no half-clipped tick label at the top edge.
      rightPriceScale: { mode: PriceScaleMode.Logarithmic, borderColor: border, entireTextOnly: true, scaleMargins: { top: 0.06, bottom: 0.04 } },
      // 5500 daily bars must compress below the default 0.5px to fit on load.
      timeScale: { borderColor: border, rightOffset: 4, minBarSpacing: 0.05 },
      localization: { timeFormatter: (t: Time) => fmtDay((t as number) * 1000), priceFormatter: fmtUsdPx },
    })
    // Bands and projection fill the full height on their own hidden scales.
    const bands = chart.addSeries(HistogramSeries, { priceScaleId: 'phase', priceLineVisible: false, lastValueVisible: false })
    const proj = chart.addSeries(HistogramSeries, { priceScaleId: 'proj', priceLineVisible: false, lastValueVisible: false })
    chart.priceScale('phase').applyOptions({ scaleMargins: { top: 0, bottom: 0 }, visible: false })
    chart.priceScale('proj').applyOptions({ scaleMargins: { top: 0, bottom: 0 }, visible: false })
    const candle = chart.addSeries(CandlestickSeries, { upColor: up, downColor: down, wickUpColor: up, wickDownColor: down, borderVisible: false })
    const sma = chart.addSeries(LineSeries, {
      color: css('--color-text-muted', '#d5d1cd'),
      lineWidth: 1,
      lastValueVisible: false,
      priceLineVisible: false,
      crosshairMarkerVisible: false,
    })
    seriesRef.current = { candle, sma, bands, proj, candleMarkers: createSeriesMarkers(candle, []), projMarkers: createSeriesMarkers(proj, []) }
    chartRef.current = chart

    const onMove = (p: MouseEventParams<Time>) => setHoverT(p.time == null ? null : (p.time as number))
    chart.subscribeCrosshairMove(onMove)
    setVersion((v) => v + 1)
    return () => {
      chart.unsubscribeCrosshairMove(onMove)
      chart.remove()
      chartRef.current = null
      seriesRef.current = null
    }
  }, [theme])

  // ── data ──
  useEffect(() => {
    const s = seriesRef.current
    if (!s || !last) return
    const phaseHex = Object.fromEntries(CYCLE_PHASES.map((p) => [p, css(PHASE_VAR[p], '#888888')])) as Record<CyclePhase, string>
    s.candle.setData(bars.map((b) => ({ time: sec(b.t), open: b.o, high: b.h, low: b.l, close: b.c })))
    s.sma.setData(bars.filter((b) => b.sma200 != null).map((b) => ({ time: sec(b.t), value: b.sma200! })))
    const panel = css('--color-panel', '#111111')
    s.bands.setData(bars.map((b) => ({ time: sec(b.t), value: 1, color: b.phase ? blend(phaseHex[b.phase], panel, 0.16) : 'rgba(0,0,0,0)' })))

    // Projection: one whitespace-or-filled bar per future step, so the time
    // axis runs on past the halving and the estimated top.
    const projLine = css('--color-proj-line', '#6ea8d8')
    const euph = phaseHex.euphoria
    const fill = { core: blend(projLine, panel, 0.3), range: blend(projLine, panel, 0.12), top: blend(euph, panel, 0.26), topRange: blend(euph, panel, 0.1) }
    const snap = (t: number) => (tf === '1w' ? weekStart(t) : Math.floor(t / DAY_MS) * DAY_MS)
    const future: { time: UTCTimestamp; value: number; color: string }[] = []
    for (let t = snap(last.t) + step; t <= projEnd; t += step) {
      const w = showProj ? windowAt(t, forecast) : null
      future.push({ time: sec(t), value: 1, color: w ? fill[w] : 'rgba(0,0,0,0)' })
    }
    s.proj.setData(future)

    const ink = css('--color-text-secondary', '#928d86')
    const first = bars[0]!.t
    const past: SeriesMarker<Time>[] = [
      ...halvings
        .filter((h) => h >= first && h <= last.t)
        .map((h) => ({ time: sec(snap(h)), position: 'belowBar' as const, shape: 'arrowUp' as const, color: ink, text: `halving ${new Date(h).getUTCFullYear()}` })),
      ...forecast.episodes
        .map((e) => (forecast.kind === 'breakout' ? e.breakout.t : e.start))
        .filter((t) => t >= first)
        .map((t) => ({ time: sec(snap(t)), position: 'aboveBar' as const, shape: 'circle' as const, color: euph, size: 1, text: `run ${fmtMonth(t)}` })),
    ].sort((a, b) => (a.time as number) - (b.time as number))
    s.candleMarkers.setMarkers(past)

    const ahead: SeriesMarker<Time>[] = []
    // Short labels: at full-history zoom the run and top medians sit ~50px apart.
    if (nextHalving > last.t) ahead.push({ time: sec(snap(nextHalving)), position: 'belowBar', shape: 'arrowUp', color: ink, text: 'halving (est.)' })
    if (showProj && forecast.onset) ahead.push({ time: sec(snap(forecast.onset.median)), position: 'aboveBar', shape: 'circle', color: projLine, text: 'run' })
    if (showProj && forecast.top) ahead.push({ time: sec(snap(forecast.top.median)), position: 'aboveBar', shape: 'circle', color: euph, text: 'top' })
    s.projMarkers.setMarkers(ahead.sort((a, b) => (a.time as number) - (b.time as number)))
  }, [version, bars, halvings, nextHalving, forecast, showProj, tf, step, projEnd, last])

  // ── visible range ──
  useEffect(() => {
    const chart = chartRef.current
    if (!chart || !last) return
    const apply = () => {
      if (range === 'all') chart.timeScale().fitContent()
      else {
        const lastTop = forecast.episodes[forecast.episodes.length - 1]?.top.t ?? last.t - 3 * 365 * DAY_MS
        chart.timeScale().setVisibleRange({ from: sec(lastTop - 180 * DAY_MS), to: sec(projEnd) })
      }
    }
    // autoSize measures via ResizeObserver, which lands after this tick.
    const raf = requestAnimationFrame(apply)
    return () => cancelAnimationFrame(raf)
  }, [version, range, bars, forecast, projEnd, last])

  const hovered = hoverT == null ? null : byTime.get(hoverT as UTCTimestamp)
  const shown = hovered ?? (hoverT == null ? last : null)
  const futureWindow = hoverT != null && !hovered && last && hoverT * 1000 > last.t ? windowAt(hoverT * 1000, forecast) : null

  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 px-[var(--panel-pad)] py-1.5">
        <div className="flex items-center gap-2">
          <Segmented label="Timeframe" options={TF_OPTIONS} value={tf} onChange={onTfChange} />
          <Segmented label="Range" options={RANGE_OPTIONS} value={range} onChange={setRange} />
          <div className="seg seg--sm" role="group" aria-label="Layers">
            <button type="button" role="checkbox" aria-checked={showProj} onClick={() => setShowProj((v) => !v)} className="seg-item" title="Projected bull-run window">
              PROJ
            </button>
          </div>
        </div>
        <PhaseLegend />
      </div>

      <div className="px-[var(--panel-pad)] pb-1 min-h-[16px] text-[10px] tabular text-text-secondary truncate">
        {shown ? (
          <>
            {fmtDay(shown.t)} · C <span className="text-text-primary">{fmtUsdPx(shown.c)}</span>
            {shown.sma200 != null && <> · SMA200 {fmtUsdPx(shown.sma200)}</>}
            {shown.mayer != null && <> · Mayer {shown.mayer.toFixed(2)}</>}
            <> · DD {fmtPct(shown.drawdown, { decimals: 0 })}</>
            {shown.trend != null && <> · trend {shown.trend.toFixed(2)}</>}
            {shown.heat != null && <> · heat {shown.heat.toFixed(2)}</>}
            {' · '}
            <span style={{ color: shown.phase ? `var(${PHASE_VAR[shown.phase]})` : undefined }}>{shown.phase ? PHASE_LABEL[shown.phase] : '—'}</span>
            <> · {shown.src}</>
          </>
        ) : hoverT != null ? (
          <>
            {fmtDay(hoverT * 1000)} · projection · {futureWindow ? WINDOW_LABEL[futureWindow] : 'outside the estimated windows'}
          </>
        ) : null}
      </div>

      <div
        ref={containerRef}
        className="w-full h-[300px] lg:h-[440px]"
        role="img"
        aria-label={`Bitcoin ${tf === '1w' ? 'weekly' : 'daily'} log price with cycle phase bands, halvings, and the projected next bull-run window`}
      />

      <div className="flex flex-wrap gap-x-4 gap-y-1 px-[var(--panel-pad)] py-1.5 text-[10px] text-text-secondary">
        <Swatch color="var(--color-text-muted)" line label="SMA200" />
        <Swatch color="color-mix(in srgb, var(--color-proj-line) 30%, transparent)" label="est. run start, core" />
        <Swatch color="color-mix(in srgb, var(--color-proj-line) 12%, transparent)" label="est. run start, range" />
        <Swatch color="color-mix(in srgb, var(--color-ph-euphoria) 26%, transparent)" label="est. top window" />
      </div>
    </div>
  )
}

function Swatch({ color, label, line }: { color: string; label: string; line?: boolean }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={line ? 'w-3 h-px' : 'w-2.5 h-2.5'} style={{ background: color }} />
      {label}
    </span>
  )
}

export function PhaseLegend() {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-text-secondary">
      {CYCLE_PHASES.map((p) => (
        <span key={p} className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5" style={{ background: `var(${PHASE_VAR[p]})` }} />
          {PHASE_LABEL[p]}
        </span>
      ))}
    </div>
  )
}
