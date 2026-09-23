import { fmtProb } from './format'

// NoulBar — a single 0..1 bar for a noul answer (a yes/no proposition read
// as a probability). Same geometry as ProbBar's track; info-blue fill; the
// number is always printed.

export function NoulBar({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(1, value)) * 100
  return (
    <div className="flex items-center gap-2">
      <span className="w-[11ch] md:w-[14ch] flex-shrink-0 text-[11px] text-text-muted">NOUL</span>
      <span className="flex-1 h-2 bg-elevated relative min-w-0" aria-hidden="true">
        <span className="absolute inset-y-0 left-0 bg-info" style={{ width: `${pct}%` }} />
      </span>
      <span className="w-[5ch] text-right tabular text-[11px] text-text-primary">{fmtProb(value)}</span>
    </div>
  )
}
