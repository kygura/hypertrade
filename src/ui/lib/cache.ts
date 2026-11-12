// Client response cache (stale-while-revalidate) behind useApi and usePoll's `cacheKey`.
// A page that was open a moment ago paints its last response at once and refetches behind it,
// instead of dropping to a skeleton on every navigation. Entries older than CACHE_MAX_AGE_MS
// are never shown. Cleared on login, logout and any 401 (lib/api.ts), so one session never
// sees another's data. Lives in memory only: a reload starts empty.

export const CACHE_MAX_AGE_MS = 5 * 60_000
const MAX_ENTRIES = 200

export interface Cached<T> {
  data: T
  /** When the response arrived (ms). */
  at: number
}

const store = new Map<string, Cached<unknown>>()
const inflight = new Map<string, Promise<unknown>>()

export function cacheGet<T>(key: string | null | undefined, now = Date.now()): Cached<T> | null {
  if (!key) return null
  const hit = store.get(key)
  if (!hit) return null
  if (now - hit.at > CACHE_MAX_AGE_MS) {
    store.delete(key)
    return null
  }
  return hit as Cached<T>
}

export function cacheSet<T>(key: string | null | undefined, data: T, now = Date.now()): void {
  if (!key) return
  store.delete(key) // re-insert so the Map's order is by last write
  store.set(key, { data, at: now })
  if (store.size > MAX_ENTRIES) store.delete(store.keys().next().value as string)
}

export function cacheClear(): void {
  store.clear()
  inflight.clear()
}

/** One request per key at a time: callers that ask while it is in flight share its promise. */
export function shared<T>(key: string, load: () => Promise<T>): Promise<T> {
  const running = inflight.get(key)
  if (running) return running as Promise<T>
  const p = load().finally(() => {
    if (inflight.get(key) === p) inflight.delete(key)
  })
  inflight.set(key, p)
  return p
}
