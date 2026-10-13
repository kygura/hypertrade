import { useCallback, useRef, useState } from 'react'
import { ApiError, NetworkError } from '../../lib/api'
import { errorMessage } from '../../lib/poll'

// One in-flight write (DESIGN §7 Level 1): busy drives the pulse label, error
// is the verbatim server string (503 `llm not configured`, 429 `LLM cap
// reached`, zod paths, Postgres messages), offline = no HTTP response at all.

export interface ActionState<A extends unknown[], R> {
  busy: boolean
  error: string | null
  /** HTTP status of the last failure, when the server answered. */
  status: number | null
  offline: boolean
  run: (...args: A) => Promise<R | undefined>
  clear: () => void
}

export function useAction<A extends unknown[], R>(fn: (...args: A) => Promise<R>): ActionState<A, R> {
  const fnRef = useRef(fn)
  fnRef.current = fn
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<number | null>(null)
  const [offline, setOffline] = useState(false)

  const run = useCallback(async (...args: A): Promise<R | undefined> => {
    setBusy(true)
    setError(null)
    setStatus(null)
    setOffline(false)
    try {
      return await fnRef.current(...args)
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return undefined // redirect in flight
      setOffline(err instanceof NetworkError)
      setStatus(err instanceof ApiError ? err.status : null)
      setError(errorMessage(err))
      return undefined
    } finally {
      setBusy(false)
    }
  }, [])

  const clear = useCallback(() => {
    setError(null)
    setStatus(null)
    setOffline(false)
  }, [])

  return { busy, error, status, offline, run, clear }
}
