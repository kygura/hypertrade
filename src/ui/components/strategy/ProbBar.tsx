import { fmtProb } from './format'

// ProbBar — one horizontal probability bar per option of a choice answer.
// Model estimates wear info-blue (DESIGN.md §2: speculation never wears the
// green/red of realized PnL); the chosen option is the only filled-info bar
// and carries a ▸ glyph so color is never the sole signal. Number always
// printed, tabular, right-aligned.

export function ProbBar({
  label,
  p,
  chosen = false,
  hint,
}: {
  label: string
  p: number
  chosen?: boolean
  hint?: string
}) {
  const pct = Math.max(0, Math.min(1, p)) * 100
  return (
    <div className="flex items-center gap-2 min-h-[var(--tap-min)] md:min-h-0" title={hint}>
      <span
        className={`w-[11ch] md:w-[14ch] flex-shrink-0 truncate text-[11px] ${chosen ? 'text-text-primary' : 'text-text-muted'}`}
      >
        {chosen ? '▸ ' : '  '}
        {label}
      </span>
      <span className="flex-1 h-2 bg-elevated relative min-w-0" aria-hidden="true">
        <span
          className={`absolute inset-y-0 left-0 ${chosen ? 'bg-info' : 'bg-text-secondary/40'}`}
          style={{ width: `${pct}%` }}
        />
      </span>
      <span className={`w-[5ch] text-right tabular text-[11px] ${chosen ? 'text-text-primary' : 'text-text-muted'}`}>
        {fmtProb(p)}
      </span>
    </div>
  )
}
