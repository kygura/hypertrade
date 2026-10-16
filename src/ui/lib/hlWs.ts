import { useEffect, useRef } from 'react'
import { HlSocket, keyOf, type HlSub } from '../../shared/hl-ws'

// The socket client lives in shared/hl-ws.ts (the server ingest uses it too);
// this file is the React adapter around one shared browser connection.
export { HlSocket, type HlSub, type WsAssetCtx, type WsCandle } from '../../shared/hl-ws'

export const hlSocket = new HlSocket()

/** Subscribe while mounted; `sub` null pauses. The handler may change freely. */
export function useHlSubscription<T>(sub: HlSub | null, handler: (data: T) => void) {
  const ref = useRef(handler)
  ref.current = handler
  const key = sub ? keyOf(sub) : null
  useEffect(() => {
    if (!sub) return
    return hlSocket.subscribe(sub, (d) => ref.current(d as T))
    // key captures sub's identity
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
}

/** Called after the socket comes back from a drop. */
export function useHlReconnect(cb: () => void) {
  const ref = useRef(cb)
  ref.current = cb
  useEffect(() => hlSocket.onReconnect(() => ref.current()), [])
}
