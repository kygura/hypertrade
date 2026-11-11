import type { GaugeReading } from '../../../shared/vector'
import { LABEL } from './format'
import { gaugeAngle, overflowMark, zoneFor, type GaugeZone } from './scales'

// Gauge (hl-cycles DESIGN §14.4.2) — a plain-SVG half dial: zone arcs, the
// 52-week average tick, last week's hollow dot and today's filled dot. The
// number, zone word and sub-row below carry the reading; the arc is a mnemonic.

const CX = 80
const CY = 84
const R = 62

function point(theta: number, r: number): [number, number] {
  return [CX + r * Math.cos(theta), CY - r * Math.sin(theta)]
}
function arc(a0: number, a1: number): string {
  const [x0, y0] = point(a0, R)
  const [x1, y1] = point(a1, R)
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${R} ${R} 0 0 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`
}
function radial(theta: number, r0: number, r1: number) {
  const [x1, y1] = point(theta, r0)
  const [x2, y2] = point(theta, r1)
  return { x1, y1, x2, y2 }
}

export function Gauge({
  label,
  reading,
  zones,
  fmt,
  word,
}: {
  label: string
  reading: GaugeReading
  zones: GaugeZone[]
  fmt: (v: number | null) => string
  /** Overrides the zone word (fundamentals/flows print the matching lens band). */
  word?: string | null
}) {
  const { now, lastWeek, avg52w } = reading
  const { min, max } = reading.scale
  const angle = (v: number) => gaugeAngle(v, min, max)

  const zone = now == null ? null : zoneFor(zones, now)
  const zoneWord = zone ? (word ?? zone.word) : null
  const nowText = now == null ? '—' : fmt(now) + overflowMark(now, min, max)
  const valuetext = `${label} ${nowText}${zoneWord ? `, ${zoneWord}` : ''}; last week ${fmt(lastWeek)}; 52-week average ${fmt(avg52w)}`

  let from = min
  const zoneArcs = zones.map((z) => {
    const d = arc(angle(from), angle(z.to))
    from = z.to
    return { d, color: z.color, to: z.to }
  })

  return (
    <div
      className="flex flex-col items-center gap-0.5 min-w-0 p-2 text-center"
      role="meter"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={now ?? undefined}
      aria-valuetext={valuetext}
    >
      <span className={LABEL}>{label}</span>
      <svg viewBox="0 0 160 92" className="w-full max-w-[168px]" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
        <path d={arc(Math.PI, 0)} stroke="var(--color-border)" strokeWidth={10} fill="none" />
        {zoneArcs.map((z) => (
          <path key={z.to} d={z.d} stroke={z.color} strokeOpacity={0.4} strokeWidth={10} fill="none" />
        ))}
        {zoneArcs.slice(0, -1).map((z) => (
          <line key={z.to} {...radial(angle(z.to), R - 7, R + 7)} stroke="var(--color-text-secondary)" strokeWidth={1} />
        ))}
        {avg52w != null && <line {...radial(angle(avg52w), 68, 82)} stroke="var(--color-text-secondary)" strokeWidth={2} />}
        {lastWeek != null &&
          (() => {
            const [x, y] = point(angle(lastWeek), R)
            return <circle cx={x} cy={y} r={5} fill="none" stroke="var(--color-text-muted)" strokeWidth={1.5} />
          })()}
        {now != null &&
          zone &&
          (() => {
            const [x, y] = point(angle(now), R)
            return <circle cx={x} cy={y} r={5.5} fill={zone.color} stroke="var(--color-text-primary)" strokeWidth={1.5} />
          })()}
      </svg>
      <span className="text-lg leading-none tabular" style={{ color: zone ? zone.color : 'var(--color-text-secondary)' }}>
        {nowText}
      </span>
      <span className="text-base text-text-muted">{zoneWord ?? 'insufficient history'}</span>
      <span className="text-xs text-text-secondary tabular">
        last wk {fmt(lastWeek)} · 52w {fmt(avg52w)}
      </span>
    </div>
  )
}
