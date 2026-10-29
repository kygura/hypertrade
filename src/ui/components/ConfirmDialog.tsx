import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react'
import { Button } from './Button'
import { ErrorBlock } from './state'

// ConfirmDialog — docs/design/README.md §7 Level 2 destructive confirm. Scrim + centered
// panel (bottom sheet on mobile via CSS, same content/markup). Focus trap:
// cancel gets initial focus; Esc closes; stays open on error.
//
// `typedWord` adds the typed-word level for the one action that earns it in
// this product: the strategy engine's kill switch (it disables every
// strategy and rejects open proposals). The confirm button stays disabled
// until the input matches the word exactly; the input gets initial focus
// instead of cancel so the operator types rather than clicks.

/**
 * The dialog shell (scrim, panel, bottom sheet on mobile). Focus goes to the
 * first `[data-autofocus]` (else the panel); Esc closes; on close focus
 * returns to `returnFocus`, else to the element that had it on open.
 */
export function DialogShell({
  title,
  onClose,
  children,
  className = 'md:max-w-[360px]',
  returnFocus,
}: {
  title: ReactNode
  onClose: () => void
  children: ReactNode
  className?: string
  returnFocus?: RefObject<HTMLElement | null>
}) {
  const id = useId()
  const panel = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const returnRef = useRef(returnFocus)
  returnRef.current = returnFocus
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    ;(panel.current?.querySelector<HTMLElement>('[data-autofocus]') ?? panel.current)?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onCloseRef.current()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      ;(returnRef.current?.current ?? opener)?.focus?.()
    }
  }, [])
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center md:items-center" style={{ background: 'var(--color-scrim)' }}>
      <div
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
        className={`panel w-full outline-none ${className}`}
        style={{ boxShadow: 'var(--shadow-overlay)' }}
      >
        <div className="panel-header">
          <span id={id} className="panel-title flex items-center gap-2">
            {title}
          </span>
        </div>
        <div className="p-3 flex flex-col gap-3">{children}</div>
      </div>
    </div>
  )
}

export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  onConfirm,
  onCancel,
  error,
  typedWord,
  busy = false,
  returnFocus,
}: {
  title: string
  body: string
  confirmLabel: string
  onConfirm: () => void
  onCancel: () => void
  error?: string | null
  typedWord?: string
  busy?: boolean
  returnFocus?: RefObject<HTMLElement | null>
}) {
  const [typed, setTyped] = useState('')
  const armed = typedWord == null || typed === typedWord

  return (
    <DialogShell title={title} onClose={onCancel} returnFocus={returnFocus}>
      <p className="text-md text-text-muted">{body}</p>
      {typedWord && (
        <label className="flex flex-col gap-1">
          <span className="label">TYPE {typedWord} TO CONFIRM</span>
          <input
            data-autofocus
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            className="w-full"
            aria-invalid={typed.length > 0 && !armed}
          />
        </label>
      )}
      {error && <ErrorBlock message={error} />}
      <div className="flex justify-end gap-2">
        <Button tier="ghost" onClick={onCancel} disabled={busy} data-autofocus={typedWord ? undefined : true}>
          CANCEL
        </Button>
        <Button tier="danger" onClick={onConfirm} disabled={!armed || busy}>
          <span className={busy ? 'pulse-label' : undefined}>{busy ? `${confirmLabel}…` : confirmLabel}</span>
        </Button>
      </div>
    </DialogShell>
  )
}
