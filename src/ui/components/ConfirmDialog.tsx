import { useEffect, useRef } from 'react'
import { Button } from './Button'
import { ErrorBlock } from './state'

// ConfirmDialog — DESIGN.md §7 Level 2 destructive confirm. Scrim + centered
// panel (bottom sheet on mobile via CSS, same content/markup). Focus trap:
// cancel gets initial focus; Esc closes; stays open on error.

export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  onConfirm,
  onCancel,
  error,
}: {
  title: string
  body: string
  confirmLabel: string
  onConfirm: () => void
  onCancel: () => void
  error?: string | null
}) {
  const cancelRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    cancelRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onCancel])

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center md:items-center" style={{ background: 'var(--color-scrim)' }}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        className="panel w-full md:max-w-[360px]"
        style={{ boxShadow: 'var(--shadow-overlay)' }}
      >
        <div className="panel-header">
          <span id="confirm-dialog-title" className="panel-title">
            {title}
          </span>
        </div>
        <div className="p-3 flex flex-col gap-3">
          <p className="text-[12px] text-text-muted">{body}</p>
          {error && <ErrorBlock message={error} />}
          <div className="flex justify-end gap-2">
            <Button tier="ghost" ref={cancelRef} onClick={onCancel}>
              CANCEL
            </Button>
            <Button tier="danger" onClick={onConfirm}>
              {confirmLabel}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
