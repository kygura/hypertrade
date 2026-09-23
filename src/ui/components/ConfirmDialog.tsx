import { useEffect, useRef, useState } from 'react'
import { Button } from './Button'
import { ErrorBlock } from './state'

// ConfirmDialog — DESIGN.md §7 Level 2 destructive confirm. Scrim + centered
// panel (bottom sheet on mobile via CSS, same content/markup). Focus trap:
// cancel gets initial focus; Esc closes; stays open on error.
//
// `typedWord` adds the typed-word level for the one action that earns it in
// this product: the strategy engine's kill switch (it disables every
// strategy and rejects open proposals). The confirm button stays disabled
// until the input matches the word exactly; the input gets initial focus
// instead of cancel so the operator types rather than clicks.

export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  onConfirm,
  onCancel,
  error,
  typedWord,
  busy = false,
}: {
  title: string
  body: string
  confirmLabel: string
  onConfirm: () => void
  onCancel: () => void
  error?: string | null
  typedWord?: string
  busy?: boolean
}) {
  const cancelRef = useRef<HTMLButtonElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [typed, setTyped] = useState('')
  const armed = typedWord == null || typed === typedWord

  useEffect(() => {
    if (typedWord) inputRef.current?.focus()
    else cancelRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onCancel, typedWord])

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
          {typedWord && (
            <label className="flex flex-col gap-1">
              <span className="label">TYPE {typedWord} TO CONFIRM</span>
              <input
                ref={inputRef}
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
            <Button tier="ghost" ref={cancelRef} onClick={onCancel} disabled={busy}>
              CANCEL
            </Button>
            <Button tier="danger" onClick={onConfirm} disabled={!armed || busy}>
              <span className={busy ? 'pulse-label' : undefined}>{busy ? `${confirmLabel}…` : confirmLabel}</span>
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
