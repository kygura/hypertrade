import { useMemo } from 'react'
import { Bar, ComposedChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { fmtPrice } from '../../shared/format'
import { EmptyBlock } from './state'
import { Segmented } from './Segmented'

// CandleChart — DESIGN.md §9.4/§11. Reusable presentational chart: the
// caller fetches candles and owns interval state, this only renders. Custom
// Bar shape draws wick + body per candle; a volume subgraph sits beneath at
// ~20% height. isAnimationActive false throughout (§8 motion ceiling).

export type CandleTf = '1H' | '4H' | '1D' | '1W'
const TFS = (['1H', '4H', '1D', '1W'] as const satisfies readonly CandleTf[]).map((v) => ({ value: v, label: v }))

export interface Candle {
  ts: number
  o: number
  h: number
  l: number
  c: number
  v: number
}

const TICK_STYLE = { fontSize: 9, fill: 'var(--color-text-secondary)' }
const TOOLTIP_STYLE = {
  background: 'var(--color-elevated)',
  border: '1px solid var(--color-border)',
  fontSize: 11,
  color: 'var(--color-text-primary)',
}

function fmtVol(n: number): string {
  if (!isFinite(n)) return '--'
  const abs = Math.abs(n)
  if (abs >= 1e9) return (n / 1e9).toFixed(2) + 'B'
  if (abs >= 1e6) return (n / 1e6).toFixed(2) + 'M'
  if (abs >= 1e3) return (n / 1e3).toFixed(2) + 'K'
  return n.toFixed(2)
}

interface CandlePoint extends Candle {
  range: [number, number]
}

function CandleShape(props: unknown) {
  const { x, y, width, height, payload } = props as { x: number; y: number; width: number; height: number; payload?: CandlePoint }
  if (!payload) return <g />
  const { o, h, l, c } = payload
  const up = c >= o
  const color = up ? 'var(--color-green)' : 'var(--color-red)'
  const span = h - l || 1
  const scale = height / span
  const bodyTop = y + (h - Math.max(o, c)) * scale
  const bodyBottom = y + (h - Math.min(o, c)) * scale
  const cx = x + width / 2
  const bodyX = x + width * 0.2
  const bodyW = width * 0.6
  return (
    <g>
      <line x1={cx} x2={cx} y1={y} y2={y + height} stroke={color} strokeWidth={1} />
      <rect x={bodyX} y={bodyTop} width={bodyW} height={Math.max(1, bodyBottom - bodyTop)} fill={color} />
    </g>
  )
}

export function CandleChart({
  candles,
  tf,
  onTfChange,
}: {
  candles: Candle[]
  tf: CandleTf
  onTfChange: (tf: CandleTf) => void
}) {
  const data = useMemo<CandlePoint[]>(() => candles.map((c) => ({ ...c, range: [c.l, c.h] })), [candles])

  return (
    <div className="flex flex-col">
      <div className="panel-header flex-shrink-0">
        <span className="panel-title">CANDLES</span>
        <Segmented label="timeframe" options={TFS} value={tf} onChange={onTfChange} />
      </div>

      {data.length === 0 ? (
        <EmptyBlock label="no candle data" />
      ) : (
        <div className="h-[240px] lg:h-[340px] flex flex-col">
          <div className="flex-[4] min-h-0 px-1 pt-1">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={data} margin={{ top: 4, right: 6, left: 0, bottom: 0 }}>
                <XAxis dataKey="ts" type="number" domain={['dataMin', 'dataMax']} hide />
                <YAxis
                  domain={['auto', 'auto']}
                  width={44}
                  tickFormatter={(v) => fmtPrice(v as number)}
                  tick={TICK_STYLE}
                  stroke="var(--color-text-secondary)"
                />
                <Tooltip
                  contentStyle={TOOLTIP_STYLE}
                  labelFormatter={(t) => new Date(t as number).toLocaleString()}
                  formatter={(_v, _n, item) => {
                    const p = item.payload as CandlePoint
                    return [
                      `O ${fmtPrice(p.o)}  H ${fmtPrice(p.h)}  L ${fmtPrice(p.l)}  C ${fmtPrice(p.c)}  V ${fmtVol(p.v)}`,
                      '',
                    ]
                  }}
                />
                <Bar dataKey="range" shape={CandleShape} isAnimationActive={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          <div className="flex-1 min-h-0 px-1 pb-1">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={data} margin={{ top: 0, right: 6, left: 0, bottom: 0 }}>
                <XAxis
                  dataKey="ts"
                  type="number"
                  domain={['dataMin', 'dataMax']}
                  tickFormatter={(t) => new Date(t as number).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                  tick={TICK_STYLE}
                  interval="preserveStartEnd"
                  minTickGap={24}
                  stroke="var(--color-text-secondary)"
                />
                <YAxis width={44} tickFormatter={(v) => fmtVol(v as number)} tick={TICK_STYLE} stroke="var(--color-text-secondary)" />
                <Bar dataKey="v" fill="var(--color-text-secondary)" fillOpacity={0.4} isAnimationActive={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </div>
  )
}
