// MomentumBadge — DESIGN.md §3/§11 (new). Signed momentum ∈ [-1, 1] as a
// tinted badge: ▲ +0.42 green / ▼ −0.31 red / — 0.05 gray for |m| < 0.15.
// Glyph + sign + number always together (color is never the sole signal).

function fmt(m: number): string {
  const sign = m >= 0 ? '+' : '−'
  return `${sign}${Math.abs(m).toFixed(2)}`
}

export function MomentumBadge({ momentum, className = '' }: { momentum: number; className?: string }) {
  const glyph = momentum >= 0.15 ? '▲' : momentum <= -0.15 ? '▼' : '—'
  const tone = momentum >= 0.15 ? 'text-green bg-green-bg' : momentum <= -0.15 ? 'text-red-text bg-red-bg' : 'text-text-secondary bg-elevated'
  return (
    <span
      className={`badge inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] tabular border border-transparent rounded-badge ${tone} ${className}`}
    >
      {glyph} {fmt(momentum)}
    </span>
  )
}
