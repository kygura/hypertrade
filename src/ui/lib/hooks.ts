import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router'

/** Re-renders every `ms` with the current time. */
export function useNow(ms = 60_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(id)
  }, [ms])
  return now
}

/** Live `matchMedia(query).matches`; true where matchMedia is missing (SSR, tests). */
export function useMedia(query: string): boolean {
  const [matches, setMatches] = useState(() => globalThis.matchMedia?.(query).matches ?? true)
  useEffect(() => {
    const mq = globalThis.matchMedia?.(query)
    if (!mq) return
    const on = () => setMatches(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [query])
  return matches
}

/** Copy of `prev` with `patch` applied. A null or empty value deletes the key. */
export function patchQuery(prev: URLSearchParams, patch: Record<string, string | null>): URLSearchParams {
  const next = new URLSearchParams(prev)
  for (const [k, v] of Object.entries(patch)) {
    if (v) next.set(k, v)
    else next.delete(k)
  }
  return next
}

/** Patches the URL query in place (replace by default, `push` adds a history entry). */
export function useQueryPatch(): (patch: Record<string, string | null>, push?: boolean) => void {
  const [, setParams] = useSearchParams()
  return useCallback(
    (patch, push = false) => setParams((p) => patchQuery(p, patch), { replace: !push }),
    [setParams],
  )
}
