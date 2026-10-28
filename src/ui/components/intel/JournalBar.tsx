import type { SourceHealth } from '../../../shared/intel'
import { Button } from '../Button'
import { StatusDot } from '../Badge'
import { Segmented, type SegmentOption } from '../Segmented'
import { ErrorBlock } from '../state'

// JournalBar — DESIGN-terminal §4.2. xl trade count (the view's one xl), the
// window, per-source health (dot + word; a failed source reads red with its
// error as title) and ghost `TAG UNTAGGED · n`. The verbatim error of a tag
// pass (503 llm not configured, 429 cap, a model failure) sits under the bar.

export type JournalDays = 7 | 30 | 90

export const JOURNAL_WINDOWS: readonly SegmentOption<JournalDays>[] = [
  { value: 7, label: '7D' },
  { value: 30, label: '30D' },
  { value: 90, label: '90D' },
]

export function JournalBar({
  count,
  days,
  onDays,
  sources,
  untagged,
  onTag,
  tagging = false,
  tagError,
  tagNote,
}: {
  count: number | null
  days: JournalDays
  onDays: (d: JournalDays) => void
  sources: SourceHealth[]
  untagged: number
  onTag: () => void
  tagging?: boolean
  tagError?: string | null
  /** Partial-pass outcome line, e.g. `tagged 4 · 1 failed`. */
  tagNote?: string | null
}) {
  return (
    <div className="panel">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2">
        <span className="flex items-baseline gap-2">
          <span className="text-xl tabular text-text-primary">{count ?? '—'}</span>
          <span className="label">{count === 1 ? 'TRADE' : 'TRADES'}</span>
        </span>
        <Segmented label="journal window" options={JOURNAL_WINDOWS} value={days} onChange={onDays} />
        {sources.length > 0 && (
          <ul className="flex flex-wrap items-center gap-3" aria-label="journal sources">
            {sources.map((s) => (
              <li
                key={s.source}
                className={`flex items-center gap-1.5 text-xs uppercase tracking-wider ${s.ok ? 'text-text-secondary' : 'text-red-text'}`}
                title={s.ok ? `${s.source}: ok` : (s.error ?? `${s.source}: failed`)}
              >
                <StatusDot status={s.ok ? 'ok' : 'down'} />
                {s.source}
                <span className="sr-only">{s.ok ? ' ok' : ` failed${s.error ? `: ${s.error}` : ''}`}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="ml-auto flex items-center gap-2">
          {tagNote && <span className="text-xs text-text-secondary">{tagNote}</span>}
          <Button tier="ghost" onClick={onTag} disabled={tagging || untagged === 0} title="the model tags each untagged trade's setup type">
            <span className={tagging ? 'pulse-label' : undefined}>{tagging ? 'TAGGING…' : `TAG UNTAGGED · ${untagged}`}</span>
          </Button>
        </div>
      </div>
      {tagError && <ErrorBlock message={tagError} onRetry={onTag} />}
    </div>
  )
}
