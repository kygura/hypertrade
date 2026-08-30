import { Line, LineChart, ResponsiveContainer } from 'recharts'

// Sparkline — DESIGN.md §4.5/§11. White 1px line, no axes, no tooltip.
// Height per breakpoint (48px mobile / 56px lg) via wrapper class, not JS.

export function Sparkline({ points, className = '' }: { points: number[]; className?: string }) {
  if (points.length < 2) return null
  const data = points.map((value, i) => ({ i, value }))
  return (
    <div className={`h-12 lg:h-14 ${className}`}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 2, right: 2, bottom: 2, left: 2 }}>
          <Line
            type="monotone"
            dataKey="value"
            stroke="var(--color-equity)"
            strokeWidth={1}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
