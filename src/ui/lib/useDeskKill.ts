import { useCallback, useState } from 'react'
import { api } from './api'
import { errorMessage } from './poll'

// useDeskKill — the one desk kill-switch flow (Desk header and Cockpit header
// share it). Arm opens the dialog, confirm POSTs the flip, a failure keeps the
// dialog open with the verbatim error, and the page refetches in `finally`.
// Not the engine's one-way kill (lib/engine.ts).

/** POST the flip, then refetch whatever the outcome. Returns the error message, or null on success. */
export async function flipDeskKill(on: boolean, refetch: () => void, post: (on: boolean) => Promise<unknown> = (v) => api.post('/desk/kill', { on: v })): Promise<string | null> {
  try {
    await post(on)
    return null
  } catch (e) {
    return errorMessage(e)
  } finally {
    refetch()
  }
}

/** `killOn` is the current switch state; confirming flips it. */
export function useDeskKill(killOn: boolean, refetch: () => void) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const arm = useCallback(() => {
    setError(null)
    setOpen(true)
  }, [])
  const cancel = useCallback(() => setOpen(false), [])
  const confirm = useCallback(async () => {
    setBusy(true)
    setError(null)
    const err = await flipDeskKill(!killOn, refetch)
    setBusy(false)
    if (err) setError(err)
    else setOpen(false)
  }, [killOn, refetch])
  return { open, busy, error, arm, cancel, confirm }
}
