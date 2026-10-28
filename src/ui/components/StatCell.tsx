import type { ReactNode } from 'react'

/** Label over a tabular value; `className` overrides the value colour (default primary). */
export function StatCell({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="label">{label}</span>
      <span className={`tabular ${className ?? 'text-text-primary'}`}>{children}</span>
    </div>
  )
}
