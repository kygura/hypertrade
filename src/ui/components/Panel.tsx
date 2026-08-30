import type { ReactNode } from 'react'

// Panel — DESIGN.md §11. Thin typed wrappers over .panel/.panel-header/
// .panel-title/.panel-body (src/ui/index.css). Verbatim port from Hyperion.

export function Panel({
  children,
  className = '',
  id,
}: {
  children: ReactNode
  className?: string
  id?: string
}) {
  return (
    <div id={id} className={`panel ${className}`}>
      {children}
    </div>
  )
}

export function PanelHeader({
  title,
  children,
  className = '',
}: {
  title: string
  children?: ReactNode
  className?: string
}) {
  return (
    <div className={`panel-header ${className}`}>
      <span className="panel-title">{title}</span>
      {children && <div className="flex items-center gap-2">{children}</div>}
    </div>
  )
}

export function PanelBody({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`panel-body ${className}`}>{children}</div>
}
