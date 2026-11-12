import type { ReactNode } from 'react'

/** One term of a reading guide: the label as printed on screen, and what it means. */
export type Term = readonly [term: string, meaning: ReactNode]

/**
 * How to read a panel. `children` is the one plain sentence that is always
 * visible: what the panel shows and what to look for. `terms` defines the
 * column heads and abbreviations, folded behind a native disclosure so dense
 * views stay dense. Facts only: what a number measures, its unit, what high
 * or low means. Never a verdict or an instruction to trade.
 */
export function HowToRead({ children, terms, className = '' }: { children: ReactNode; terms?: readonly Term[]; className?: string }) {
  return (
    <div className={`how-to-read text-sm text-text-muted leading-relaxed max-w-[90ch] ${className}`}>
      <p className="m-0">{children}</p>
      {terms && terms.length > 0 && (
        <details className="mt-1">
          <summary className="cursor-pointer select-none text-text-secondary hover:text-text-primary w-fit">What the terms mean</summary>
          <dl className="mt-2 mb-0 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
            {terms.map(([term, meaning]) => (
              <div key={term} className="contents">
                <dt className="text-text-primary whitespace-nowrap">{term}</dt>
                <dd className="m-0">{meaning}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}
    </div>
  )
}
