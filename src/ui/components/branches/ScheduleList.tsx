import type { BranchConfig } from '../../../shared/types'
import { moveLines } from './format'

/** Scheduled moves of a branch, in date order: fill date (once run), hindsight window, label, holdings after. */
export function ScheduleList({
  schedule,
  filled,
  onRemove,
}: {
  schedule: NonNullable<BranchConfig['schedule']>
  filled?: { step: number; date: string }[]
  onRemove?: (index: number) => void
}) {
  return (
    <ol className="flex flex-col gap-1 text-sm">
      {moveLines(schedule, filled).map((m, i) => (
        <li key={i} className="flex flex-wrap items-baseline gap-x-2">
          <span className="tabular text-text-primary">{m.when}</span>
          {m.note && <span className="text-text-secondary">{m.note}</span>}
          <span className="text-text-primary">→ {m.holdings}</span>
          {m.window && <span className="text-xs text-text-muted">{m.window}</span>}
          {onRemove && (
            <button type="button" className="text-xs text-text-muted hover:text-text-primary" onClick={() => onRemove(i)} aria-label={`remove move ${i + 1}`}>
              REMOVE
            </button>
          )}
        </li>
      ))}
    </ol>
  )
}
