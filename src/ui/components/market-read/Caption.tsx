import type { ReactNode } from 'react'

/** The one-line plain caption under a landing panel header: what it shows and how to read it. */
export function Caption({ children }: { children: ReactNode }) {
  return <p className="px-3 pt-2 text-xs text-text-secondary">{children}</p>
}
