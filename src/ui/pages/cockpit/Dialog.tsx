import { useEffect, useRef, type ReactNode } from 'react'

// Dialog shell — the ConfirmDialog markup (scrim, panel, bottom sheet on
// mobile) for the cockpit dialogs whose body is more than a sentence. Esc
// closes; focus goes to `initialFocus` (or the panel) and back to the opener
// on close (DESIGN-terminal C3 `Esc`).

export function Dialog({ title, onClose, children, wide = false }: { title: ReactNode; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const panel = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    const first = panel.current?.querySelector<HTMLElement>('[data-autofocus]') ?? panel.current
    first?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onCloseRef.current()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      opener?.focus?.()
    }
  }, [])
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center md:items-center" style={{ background: 'var(--color-scrim)' }} data-cockpit-dialog>
      <div
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="cockpit-dialog-title"
        className={`panel w-full ${wide ? 'md:max-w-[480px]' : 'md:max-w-[400px]'} outline-none`}
        style={{ boxShadow: 'var(--shadow-overlay)' }}
      >
        <div className="panel-header">
          <span id="cockpit-dialog-title" className="panel-title flex items-center gap-2">
            {title}
          </span>
        </div>
        <div className="p-3 flex flex-col gap-3">{children}</div>
      </div>
    </div>
  )
}

/** Amber strip with minute/second copy (StaleBanner is hour-based, so the same look with C7's words). */
export function StaleStrip({ children }: { children: ReactNode }) {
  return <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-amber bg-amber-bg border-b border-border-subtle">{children}</div>
}
