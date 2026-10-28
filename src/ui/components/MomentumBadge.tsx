import { Badge, type Tone } from './Badge'

// MomentumBadge — docs/design/README.md §3/§11 (new). Signed momentum ∈ [-1, 1] as a
// tinted badge: ▲ +0.42 green / ▼ −0.31 red / — 0.05 gray for |m| < 0.15.
// Glyph + sign + number always together (color is never the sole signal).

function fmt(m: number): string {
  const sign = m >= 0 ? '+' : '−'
  return `${sign}${Math.abs(m).toFixed(2)}`
}

export function MomentumBadge({ momentum, className = '' }: { momentum: number; className?: string }) {
  const glyph = momentum >= 0.15 ? '▲' : momentum <= -0.15 ? '▼' : '—'
  const tone: Tone = momentum >= 0.15 ? 'green' : momentum <= -0.15 ? 'red' : 'gray'
  return (
    <Badge tone={tone} className={`tabular ${className}`}>
      {glyph} {fmt(momentum)}
    </Badge>
  )
}
