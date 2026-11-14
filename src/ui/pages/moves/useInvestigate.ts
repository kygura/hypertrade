import { useCallback, useRef, useState } from 'react'
import { ApiError } from '../../lib/api'
import { moves } from '../../lib/moves'
import { investigateFailure } from './logic'

// INVESTIGATE (one agent run) shared by MOVES and the COIN page: the coins in flight, the last failure's words
// (409 / 429 / 503 via investigateFailure) and the action. `onSettled` runs after every attempt (refetch).

export interface ActionError { coin: string; message: string }

export function useInvestigate(onSettled: () => void) {
  const [busy, setBusy] = useState<string[]>([])
  const [actionError, setActionError] = useState<ActionError | null>(null)
  const settled = useRef(onSettled)
  settled.current = onSettled
  const investigate = useCallback(async (coin: string) => {
    setActionError(null)
    setBusy((b) => (b.includes(coin) ? b : [...b, coin]))
    try {
      await moves.investigate(coin)
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return
      setActionError({ coin, message: investigateFailure(e instanceof ApiError ? e.status : undefined, e instanceof Error ? e.message : '') })
    } finally {
      setBusy((b) => b.filter((c) => c !== coin))
      settled.current()
    }
  }, [])
  return { busy, actionError, investigate }
}
