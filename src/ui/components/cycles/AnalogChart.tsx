import { useMemo } from 'react'
import { CartesianGrid, Line, LineChart, ReferenceArea, ReferenceDot, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { CycleAnalog, CycleForecast } from '../../../shared/cycleForecast'
import { DAY_MS } from '../../../shared/cycles'
import { fmtMonth } from './format'

// Cycle analogs — each cycle's price from its top, indexed to the top close
// (1 = the top), on a log scale against days since the top. The live cycle is
// the bright line; dots mark where each past cycle's next bull run started
// (by the selected run-start definition), and the blue band is the forecast's
// core window in the same units.

const HORIZON = 1400
const Y_TICKS = [0.1, 0.2, 0.5, 1, 2, 5]
const PAST_COLORS = ['var(--color-cyc-1)', 'var(--color-cyc-2)', 'var(--color-cyc-3)']

const fmtRatio = (r: number) => (Math.abs(r - 1) < 1e-9 ? 'top' : r < 1 ? `${Math.round((r - 1) * 100)}%` : `${r}×`)

type Row = { d: number } & Record<string, number>

export function AnalogChart({ analogs, forecast }: { analogs: CycleAnalog[]; forecast: CycleForecast }) {
  // Keep the three most recent past cycles: older ones would need a fourth hue.
  const past = analogs.filter((a) => !a.current).slice(-3)
  const live = analogs.find((a) => a.current) ?? null
  const shown = live ? [...past, live] : past
  const color = (a: CycleAnalog) => (a.current ? 'var(--color-text-primary)' : PAST_COLORS[past.indexOf(a)]!)

  const rows = useMemo(() => {
    const byDay = new Map<number, Row>()
    for (const a of shown)
      for (const p of a.points) {
        if (p.d > HORIZON) continue
        const row = byDay.get(p.d) ?? ({ d: p.d } as Row)
        row[a.label] = p.r
        byDay.set(p.d, row)
      }
    return [...byDay.values()].sort((x, y) => x.d - y.d)
  }, [shown])

  const nearest = (a: CycleAnalog, day: number) => a.points.reduce((b, p) => (Math.abs(p.d - day) < Math.abs(b.d - day) ? p : b), a.points[0]!)
  const today = live ? live.points[live.points.length - 1]! : null
  const onset = forecast.onset
  const startDay = (a: CycleAnalog) => (forecast.kind === 'breakout' ? a.breakoutDay : a.onsetDay)
  const core = live && onset ? { from: Math.round((onset.p25 - live.topT) / DAY_MS), to: Math.round((onset.p75 - live.topT) / DAY_MS) } : null

  if (shown.length === 0) return null
  return (
    <div className="flex flex-col">
      <ResponsiveContainer width="100%" height={300}>
        <LineChart data={rows} margin={{ top: 8, right: 12, left: 4, bottom: 4 }}>
          <CartesianGrid stroke="var(--color-border-subtle)" vertical={false} />
          <XAxis
            dataKey="d"
            type="number"
            domain={[0, HORIZON]}
            ticks={[0, 200, 400, 600, 800, 1000, 1200, 1400]}
            tickFormatter={(d: number) => `${d}d`}
            tick={{ fontSize: 10, fill: 'var(--color-text-secondary)' }}
            stroke="var(--color-border)"
          />
          <YAxis
            scale="log"
            domain={[0.1, 6]}
            allowDataOverflow
            ticks={Y_TICKS}
            tickFormatter={fmtRatio}
            tick={{ fontSize: 10, fill: 'var(--color-text-secondary)' }}
            stroke="var(--color-border)"
            width={40}
          />
          {core && <ReferenceArea x1={core.from} x2={core.to} fill="var(--color-proj-line)" fillOpacity={0.14} stroke="none" ifOverflow="hidden" />}
          <ReferenceLine y={1} stroke="var(--color-border)" strokeDasharray="3 3" />
          {today && <ReferenceLine x={today.d} stroke="var(--color-text-secondary)" strokeDasharray="2 3" label={{ value: 'today', position: 'insideTopLeft', fontSize: 10, fill: 'var(--color-text-secondary)' }} />}
          <Tooltip
            cursor={{ stroke: 'var(--color-border)' }}
            content={({ active, label, payload }) =>
              active && payload?.length ? (
                <div className="bg-elevated border border-border px-2 py-1.5 text-[10px] tabular flex flex-col gap-0.5">
                  <span className="text-text-secondary">day {label} after the top</span>
                  {payload.map((p) => (
                    <span key={String(p.dataKey)} className="flex items-center gap-1.5 text-text-primary">
                      <span className="w-2 h-0.5" style={{ background: p.color }} />
                      {p.dataKey} cycle · {fmtRatio(Math.round(Number(p.value) * 100) / 100)}
                    </span>
                  ))}
                </div>
              ) : null
            }
          />
          {shown.map((a) => (
            <Line
              key={a.label}
              dataKey={a.label}
              stroke={color(a)}
              strokeWidth={2}
              dot={false}
              connectNulls
              isAnimationActive={false}
            />
          ))}
          {past
            .filter((a) => startDay(a) != null && startDay(a)! <= HORIZON)
            .map((a) => {
              const p = nearest(a, startDay(a)!)
              return <ReferenceDot key={a.label} x={p.d} y={p.r} r={4} fill={color(a)} stroke="var(--color-panel)" strokeWidth={2} />
            })}
        </LineChart>
      </ResponsiveContainer>
      <div className="flex flex-wrap gap-x-4 gap-y-1 px-[var(--panel-pad)] py-1.5 text-[10px] text-text-secondary">
        {shown.map((a) => (
          <span key={a.label} className="flex items-center gap-1.5">
            <span className="w-3 h-0.5" style={{ background: color(a) }} />
            {a.label} top{a.current ? ' (live)' : ''}
            {startDay(a) != null && <span>· next run +{startDay(a)}d</span>}
          </span>
        ))}
        <span className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-text-secondary" />
          next run started
        </span>
        {core && onset && (
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5" style={{ background: 'color-mix(in srgb, var(--color-proj-line) 14%, transparent)' }} />
            est. core window {fmtMonth(onset.p25)} – {fmtMonth(onset.p75)}
          </span>
        )}
      </div>
    </div>
  )
}
