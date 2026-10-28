import type { KeyboardEvent } from 'react'
import type { Thesis } from '../../../shared/intel'
import { ClaimAge } from './ClaimAge'

// ThesisList — DESIGN-terminal §5.2. Focusable rows (--row-h, aria-selected,
// Enter/Space select): `▸` on the selected row, the first line of the text
// (ellipsis, full text as title), counts `1✗ 4✓ 2?` with hidden words (the
// contradicted number red when > 0), ClaimAge of the last check.

export function thesisCounts(t: Pick<Thesis, 'claims'>): { contradicted: number; supported: number; unknown: number } {
  const n = { contradicted: 0, supported: 0, unknown: 0 }
  for (const c of t.claims) n[c.status]++
  return n
}

export function firstLine(text: string): string {
  return text.split('\n').find((l) => l.trim())?.trim() ?? text
}

export function ThesisList({ theses, selectedId, onSelect }: { theses: Thesis[]; selectedId: string | null; onSelect: (id: string) => void }) {
  const onKey = (e: KeyboardEvent<HTMLLIElement>, id: string) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onSelect(id)
    }
  }
  return (
    <ul role="listbox" aria-label="saved theses" className="flex flex-col">
      {theses.map((t) => {
        const sel = t.id === selectedId
        const n = thesisCounts(t)
        return (
          <li
            key={t.id}
            role="option"
            aria-selected={sel}
            tabIndex={0}
            onClick={() => onSelect(t.id)}
            onKeyDown={(e) => onKey(e, t.id)}
            style={{ minHeight: 'var(--row-h)' }}
            className={`flex items-center gap-2 px-3 text-md border-b border-border-subtle cursor-pointer hover:bg-hover ${sel ? 'bg-selected' : ''}`}
          >
            <span aria-hidden="true" className="w-2 flex-shrink-0 text-text-secondary">
              {sel ? '▸' : ''}
            </span>
            <span className="flex-1 min-w-0 truncate text-text-primary" title={t.text}>
              {firstLine(t.text)}
            </span>
            <span className="flex-shrink-0 tabular text-sm whitespace-nowrap">
              <span className={n.contradicted > 0 ? 'text-red-text' : 'text-text-secondary'}>
                {n.contradicted}
                <span aria-hidden="true">✗</span>
                <span className="sr-only"> contradicted,</span>
              </span>{' '}
              <span className="text-text-muted">
                {n.supported}
                <span aria-hidden="true">✓</span>
                <span className="sr-only"> supported,</span>
              </span>{' '}
              <span className="text-text-muted">
                {n.unknown}
                <span aria-hidden="true">?</span>
                <span className="sr-only"> unknown</span>
              </span>
            </span>
            <span className="flex-shrink-0 w-8 text-right">{t.checkedAt ? <ClaimAge ts={t.checkedAt} /> : <span className="text-xs text-text-secondary">—</span>}</span>
          </li>
        )
      })}
    </ul>
  )
}
