import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  PriceScaleMode,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type MouseEventParams,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts'
import type { RegimeState, VectorResponse } from '../../../shared/vector'
import { useTheme } from '../../themes/registry'
import { HowToRead, type Term } from '../HowToRead'
import { Segmented } from '../Segmented'
import { alpha, css } from '../charts/theme'
import { fmtUsdPx } from '../cycles/format'
import { fmtDate, fmtDeltaPts, fmtInt, fmtPrice } from './format'
import { DAY_MS, REGIME_STATES, REGIME_VAR, REGIME_WORD, regimeColor } from './scales'

// RegimeChart (hl-cycles DESIGN §14.4.3) — BTC daily log price coloured by
// Vector regime, a regime dot strip along the bottom, numbered flip markers
// and optional key-level price lines. Same lightweight-charts setup as
// CycleChart: rebuilt on theme change so canvas colours follow the tokens.

type Preset = '1Y' | '4Y' | 'ALL'
const PRESET_OPTIONS = [
  { value: '1Y' as const, label: '1Y' },
  { value: '4Y' as const, label: '4Y' },
  { value: 'ALL' as const, label: 'ALL' },
]
const YEAR_MS = 365 * DAY_MS
const RECENT = 4
const sec = (ms: number) => Math.floor(ms / 1000) as UTCTimestamp
const isOff = (s: RegimeState) => s.endsWith('risk_off')
const word = (s: RegimeState) => REGIME_WORD[s].toLowerCase()
/** ①–⑳ in UI text; plain digits past 20. */
const circled = (n: number): string => (n >= 1 && n <= 20 ? String.fromCharCode(0x2460 + n - 1) : String(n))

const CHART_TERMS: readonly Term[] = [
  ['Line colour', 'The regime the model had committed to on that day (legend at top right). Grey means no regime yet: the on-chain inputs it needs start in late 2022.'],
  ['Bottom strip', 'The same regime colours as a band, so changes are visible when the line is flat.'],
  ['Numbered dots', 'Flips: days the regime reached the opposite extreme, strong risk-on after the last extreme was strong risk-off, or the reverse. Moves through the mild states are not flips. A dot above the line is a flip to strong risk-off, below it to strong risk-on. The last four are numbered and listed under the chart with the price that day.'],
  ['Price axis', 'USD on a log scale: equal distances are equal percent moves.'],
  ['1Y · 4Y · ALL', 'Visible range ending at the last close. Double-click the chart to reset it.'],
  ['LEVELS', 'Draws the key levels from the levels table as dashed lines. On by default at 1Y only, because they bunch up over longer ranges.'],
  ['risk', 'In the readout: share of the six stress conditions active that day, 0 to 100.'],
  ['momentum', 'In the readout: the momentum score that day, −100 to +100.'],
]

type Series = { price: ISeriesApi<'Line'>; strip: ISeriesApi<'Histogram'>; markers: ISeriesMarkersPluginApi<Time> }

export function RegimeChart({
  history,
  flips,
  levels,
  asOf,
}: {
  history: VectorResponse['history']
  flips: VectorResponse['flips']
  levels: VectorResponse['levels']
  asOf: number | null
}) {
  const [theme] = useTheme()
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<Series | null>(null)
  const [version, setVersion] = useState(0)
  const [preset, setPreset] = useState<Preset>('4Y')
  // Levels bunch up on a log scale over long ranges: on at 1Y only, reset by each preset change.
  const [showLevels, setShowLevels] = useState(false)
  const [hoverT, setHoverT] = useState<number | null>(null)

  const byTime = useMemo(() => new Map(history.map((h) => [sec(h.t) as number, h])), [history])

  // ── chart lifecycle ──
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const text = css('--color-text-secondary', '#928d86')
    const border = css('--color-border', 'rgba(255,255,255,0.08)')
    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: text,
        fontFamily: css('--font-mono', 'ui-monospace, monospace'),
        fontSize: 12,
        attributionLogo: false,
      },
      grid: { vertLines: { color: alpha(border, 0.6) }, horzLines: { color: alpha(border, 0.6) } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { mode: PriceScaleMode.Logarithmic, borderColor: border, entireTextOnly: true, scaleMargins: { top: 0.06, bottom: 0.06 } },
      timeScale: { borderColor: border, rightOffset: 4, minBarSpacing: 0.05 },
      localization: { timeFormatter: (t: Time) => fmtDate((t as number) * 1000), priceFormatter: fmtUsdPx },
    })
    const strip = chart.addSeries(HistogramSeries, { priceScaleId: 'regime', priceLineVisible: false, lastValueVisible: false })
    chart.priceScale('regime').applyOptions({ scaleMargins: { top: 0.965, bottom: 0 }, visible: false })
    // 1.5px per the hl-cycles spec; the LineWidth type lists integers but the canvas accepts it.
    const price = chart.addSeries(LineSeries, {
      lineWidth: 1.5 as 1,
      lastValueVisible: true,
      priceLineVisible: false,
      color: text,
    })
    seriesRef.current = { price, strip, markers: createSeriesMarkers(price, []) }
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

  // ── data, strip and flip markers ──
  useEffect(() => {
    const s = seriesRef.current
    if (!s) return
    const hex = Object.fromEntries(REGIME_STATES.map((st) => [st, css(REGIME_VAR[st], '#9aa3ad')])) as Record<RegimeState, string>
    const none = css('--color-text-secondary', '#928d86')
    s.price.setData(history.map((h) => ({ time: sec(h.t), value: h.price, color: h.state ? hex[h.state] : none })))
    s.strip.setData(history.map((h) => ({ time: sec(h.t), value: 1, color: h.state ? alpha(hex[h.state], 0.85) : 'rgba(0,0,0,0)' })))
    // Markers must sit on an existing bar: snap each flip to its UTC day. Every flip
    // gets a dot; only the last four carry numbers, matching the list under the chart.
    const ink = css('--color-text-muted', '#d5d1cd')
    const firstNumbered = flips.length - RECENT
    s.markers.setMarkers(
      flips.map((f, i) => ({
        time: sec(Math.floor(f.t / DAY_MS) * DAY_MS),
        position: isOff(f.to) ? ('aboveBar' as const) : ('belowBar' as const),
        shape: 'circle' as const,
        color: ink,
        size: 1,
        text: i >= firstNumbered ? String(i + 1) : undefined,
      })),
    )
  }, [version, history, flips])

  // ── visible range ──
  useEffect(() => {
    const chart = chartRef.current
    if (!chart || history.length === 0) return
    const apply = () => {
      if (preset === 'ALL' || asOf == null) chart.timeScale().fitContent()
      else chart.timeScale().setVisibleRange({ from: sec(asOf - (preset === '1Y' ? 1 : 4) * YEAR_MS), to: sec(asOf) })
    }
    // autoSize measures via ResizeObserver, which lands after this tick.
    const raf = requestAnimationFrame(apply)
    const el = containerRef.current
    el?.addEventListener('dblclick', apply)
    return () => {
      cancelAnimationFrame(raf)
      el?.removeEventListener('dblclick', apply)
    }
  }, [version, preset, asOf, history])

  // ── key levels as dashed price lines ──
  useEffect(() => {
    const price = seriesRef.current?.price
    if (!price || !showLevels) return
    const color = css('--color-text-secondary', '#928d86')
    const lines: IPriceLine[] = levels
      .filter((l) => l.value != null)
      .map((l) =>
        price.createPriceLine({
          price: l.value as number,
          color,
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: l.proxy ? `${l.label} ~` : l.label,
        }),
      )
    return () => lines.forEach((pl) => price.removePriceLine(pl))
  }, [version, levels, showLevels])

  const last = history[history.length - 1]
  const hovered = hoverT == null ? null : byTime.get(hoverT)
  const shown = hovered ?? (hoverT == null ? last : null)
  const recent = flips.slice(-RECENT)
  const older = flips.slice(0, -RECENT)
  const olderTitle = older.map((f, i) => `${i + 1}. ${fmtDate(f.t)} ${word(f.from)} → ${word(f.to)} ${fmtPrice(f.price)}`).join('\n')

  return (
    <div className="flex flex-col">
      <HowToRead className="px-[var(--panel-pad)] py-2 border-b border-border-subtle" terms={CHART_TERMS}>
        BTC daily close, coloured by the regime the model read on each day. Look at where the colour changed relative to turns in price, and
        how long each stretch lasted.
      </HowToRead>
      <div className="flex flex-wrap items-center justify-between gap-2 px-[var(--panel-pad)] py-1.5">
        <div className="flex items-center gap-2">
          <Segmented
            label="Range"
            options={PRESET_OPTIONS}
            value={preset}
            onChange={(p) => {
              setPreset(p)
              setShowLevels(p === '1Y')
            }}
          />
          <div className="seg seg--sm" role="group" aria-label="Layers">
            <button
              type="button"
              role="checkbox"
              aria-checked={showLevels}
              onClick={() => setShowLevels((v) => !v)}
              className="seg-item"
              title="Key levels as dashed price lines"
            >
              LEVELS
            </button>
          </div>
        </div>
        <RegimeLegend />
      </div>

      <div className="px-[var(--panel-pad)] pb-1 min-h-[16px] text-xs tabular text-text-secondary truncate">
        {shown && (
          <>
            {fmtDate(shown.t)} · <span className="text-text-primary">{fmtPrice(shown.price)}</span> ·{' '}
            <span style={{ color: regimeColor(shown.state) }}>{shown.state ? REGIME_WORD[shown.state] : '—'}</span> · risk{' '}
            {fmtInt(shown.riskOff == null ? null : shown.riskOff * 100)} · momentum {fmtDeltaPts(shown.momentum)}
          </>
        )}
      </div>

      <div className="relative">
        <div
          ref={containerRef}
          className="w-full h-[300px] lg:h-[420px]"
          role="img"
          aria-label={`Bitcoin daily log price coloured by Vector regime, ${fmtDate(history[0]?.t)} to ${fmtDate(asOf)}`}
        />
        {history.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-text-secondary">No daily BTC price history loaded yet, so there is nothing to draw.</div>
        )}
      </div>

      <div className="flex flex-col gap-1 px-[var(--panel-pad)] py-1.5 text-xs tabular text-text-secondary" title={olderTitle || undefined}>
        {flips.length === 0 ? (
          <span>No flips yet: the regime has not gone from one extreme (strong risk-on or strong risk-off) to the other in this history.</span>
        ) : (
          recent.map((f, i) => {
            const n = flips.length - recent.length + i + 1
            return (
              <span key={f.t}>
                {circled(n)} {fmtDate(f.t)} · <span style={{ color: regimeColor(f.from) }}>{word(f.from)}</span> →{' '}
                <span style={{ color: regimeColor(f.to) }}>{word(f.to)}</span> · {fmtPrice(f.price)}
              </span>
            )
          })
        )}
      </div>
    </div>
  )
}

function RegimeLegend() {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-text-secondary">
      {REGIME_STATES.map((s) => (
        <span key={s} className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5" style={{ background: `var(${REGIME_VAR[s]})` }} />
          {word(s)}
        </span>
      ))}
    </div>
  )
}
