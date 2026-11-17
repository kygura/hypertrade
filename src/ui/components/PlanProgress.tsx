// PlanProgress — where a position sits inside its own plan, without money.
// One quiet bar from stop (left) to target (right) with a tick for the mark
// and an optional entry tick, plus R so far (`+0.6R`). Without a target there
// is no bar: distance to stop and R only. The colour stays neutral; the
// number carries the meaning.

export type PlanSide = 'long' | 'short'

const MINUS = '−'

/** Distance from mark to stop in percent (absolute), or null without a stop. */
export function stopDistPct(p: { markPx: number; stopPx: number | null }): number | null {
  if (p.stopPx == null || !(p.markPx > 0)) return null
  return (Math.abs(p.markPx - p.stopPx) / p.markPx) * 100
}

/**
 * R so far: the move from entry to mark in units of the planned risk (entry to stop),
 * signed for the side. Null without a stop, or when the stop is not on the losing side of entry.
 */
export function rMultiple(side: PlanSide, entry: number, mark: number, stop: number | null): number | null {
  if (stop == null || ![entry, mark, stop].every(Number.isFinite)) return null
  const dir = side === 'long' ? 1 : -1
  const risk = (entry - stop) * dir
  if (!(risk > 0)) return null
  return ((mark - entry) * dir) / risk
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x))

/**
 * Fraction 0..1 of `px` along the stop → target line, clamped. Works for both sides:
 * a short's stop sits above its target and the ratio still runs stop (0) to target (1).
 */
export function planFraction(px: number, stop: number, target: number): number | null {
  const span = target - stop
  if (!Number.isFinite(px) || !Number.isFinite(span) || span === 0) return null
  return clamp01((px - stop) / span)
}

/** `+0.6R`, `−1.0R`, `0.0R`; null → `—`. */
export function fmtR(r: number | null): string {
  if (r == null || !Number.isFinite(r)) return '—'
  const v = Math.abs(r) < 0.05 ? 0 : r
  return `${v > 0 ? '+' : v < 0 ? MINUS : ''}${Math.abs(v).toFixed(1)}R`
}

export interface PlanProgressProps {
  side: PlanSide
  entry: number
  mark: number
  stop: number | null
  target?: number | null
  /** Draw the entry tick on the bar (default true). */
  showEntry?: boolean
  className?: string
}

export function PlanProgress({ side, entry, mark, stop, target = null, showEntry = true, className = '' }: PlanProgressProps) {
  const r = fmtR(rMultiple(side, entry, mark, stop))
  if (stop == null) {
    return <span className={`text-xs text-text-secondary tabular ${className}`}>no stop</span>
  }
  const markAt = target != null ? planFraction(mark, stop, target) : null
  const dist = stopDistPct({ markPx: mark, stopPx: stop })
  const distText = dist == null ? '' : `${dist.toFixed(1)}% to stop`

  if (markAt == null || target == null) {
    return (
      <span className={`inline-flex items-center gap-2 text-xs tabular whitespace-nowrap ${className}`} title={`stop ${stop}, no target`}>
        <span className="text-text-secondary">{distText}</span>
        <span className="text-text-muted">{r}</span>
      </span>
    )
  }

  const entryAt = showEntry ? planFraction(entry, stop, target) : null
  return (
    <span
      className={`inline-flex items-center gap-2 text-xs tabular whitespace-nowrap ${className}`}
      title={`stop ${stop} → target ${target}; mark ${mark}${distText ? ` (${distText})` : ''}`}
    >
      <span
        role="meter"
        aria-label="mark between stop and target"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(markAt * 100)}
        aria-valuetext={`${Math.round(markAt * 100)}% of the way from stop to target, ${r}`}
        className="relative inline-block w-16 h-1 bg-elevated"
      >
        {entryAt != null && <span aria-hidden="true" className="absolute top-[-2px] h-2 w-px bg-text-disabled" style={{ left: `${entryAt * 100}%` }} />}
        <span
          aria-hidden="true"
          data-plan-mark=""
          className="absolute top-[-3px] h-2.5 w-0.5 -ml-px bg-text-muted transition-[left] duration-500 ease-out"
          style={{ left: `${markAt * 100}%` }}
        />
      </span>
      <span className="text-text-muted">{r}</span>
    </span>
  )
}
