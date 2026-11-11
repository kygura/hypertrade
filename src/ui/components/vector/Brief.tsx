import type { VectorResponse, WocPhase } from '../../../shared/vector'
import { EmptyBlock } from '../state'

// Brief (hl-cycles DESIGN §14.4.7) — the model's numbered claims, verbatim from
// the API. Confirm / invalidate live in the hero, not here.

export const briefTitle = (wocPhase: WocPhase | null) => `BRIEF${wocPhase ? ` · ${wocPhase.replace(/_/g, ' ').toUpperCase()}` : ''}`

export function Brief({ brief }: { brief: VectorResponse['brief'] }) {
  if (brief.sentences.length === 0) return <EmptyBlock label="no brief — the model has not produced a reading yet" />
  return (
    <ol className="flex flex-col gap-2 p-3">
      {brief.sentences.map((s, i) => (
        <li key={i} className="grid grid-cols-[24px_1fr] items-baseline">
          <span className="text-xs text-text-secondary tabular">{i + 1}</span>
          <span className="text-base text-text-muted max-w-[72ch]">{s}</span>
        </li>
      ))}
    </ol>
  )
}
