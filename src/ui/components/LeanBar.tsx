import { leanFill } from '../lib/lab'

// LeanBar — DESIGN.md §10.9 Pulse/§11. Bipolar 8px bar: fill grows from a 1px
// center tick, green right for lean > 0, red left for lean < 0, width
// |lean| × 50%. Decoration only (aria-hidden): the caller always prints the
// signed number beside it.

export function LeanBar({ lean, width = 120, className = '' }: { lean: number; width?: number | string; className?: string }) {
  const { side, pct } = leanFill(lean)
  return (
    <span
      aria-hidden="true"
      className={`relative inline-block h-2 bg-elevated flex-shrink-0 ${className}`}
      style={{ width }}
    >
      {side && (
        <span
          className={`absolute top-0 bottom-0 ${side === 'right' ? 'bg-green' : 'bg-red'}`}
          style={side === 'right' ? { left: '50%', width: `${pct}%` } : { right: '50%', width: `${pct}%` }}
        />
      )}
      <span className="absolute -top-0.5 -bottom-0.5 left-1/2 w-px bg-border" />
    </span>
  )
}
