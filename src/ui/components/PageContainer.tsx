import type { ReactNode } from 'react'

// PageContainer — the shared page wrapper: max width 1440, shell gutter.
export function PageContainer({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`max-w-[1440px] mx-auto px-3 md:px-[var(--gutter)] ${className}`.trim()}>{children}</div>
}
