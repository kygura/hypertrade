import type { RefObject } from 'react'
import { ConfirmDialog } from './ConfirmDialog'

// KillSwitchDialog — Level 3 typed-word confirm for the desk kill switch
// (docs/CONSOLIDATION.md "Confirmation levels"). Resuming is plain Level 2.
export function KillSwitchDialog({
  killOn,
  busy,
  error,
  onConfirm,
  onCancel,
  returnFocus,
}: {
  killOn: boolean
  busy: boolean
  error: string | null
  onConfirm: () => void
  onCancel: () => void
  returnFocus?: RefObject<HTMLElement | null>
}) {
  return (
    <ConfirmDialog
      title={killOn ? 'Resume entries' : 'Kill switch'}
      body={killOn ? 'New entries will be allowed again, within the governor limits.' : 'Blocks every new entry, from agents and approvals alike. Exits stay allowed.'}
      confirmLabel={killOn ? 'RESUME' : 'KILL'}
      typedWord={killOn ? undefined : 'KILL'}
      onConfirm={onConfirm}
      onCancel={onCancel}
      error={error}
      busy={busy}
      returnFocus={returnFocus}
    />
  )
}
