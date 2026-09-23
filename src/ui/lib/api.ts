import { useCallback, useEffect, useState } from 'react'

// Tiny fetch wrapper — JSON in/out, credentials included, 401 redirects to
// /login (SPEC.md: "Frontend route guard redirects to /login"). The intended
// path is remembered so LoginForm can return there on success.

export class ApiError extends Error {
  status: number
  /** Offending field when the server names one (`{ error, field }`, e.g. the engine's 400s). */
  field?: string
  constructor(message: string, status: number, field?: string) {
    super(message)
    this.status = status
    this.field = field
  }
}

// Thrown when fetch() itself rejects — no HTTP response was received at all
// (DNS failure, offline, connection refused) — as opposed to ApiError, which
// means the server responded with a non-2xx status. DESIGN.md §6 OfflineBlock
// is for this case specifically.
export class NetworkError extends Error {}

const REDIRECT_KEY = 'ht_redirect_to'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(`/api${path}`, {
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
      ...init,
    })
  } catch (err) {
    throw new NetworkError(err instanceof Error ? err.message : 'network unreachable')
  }

  if (res.status === 401 && path !== '/auth/login') {
    sessionStorage.setItem(REDIRECT_KEY, location.pathname)
    location.href = '/login'
    throw new ApiError('unauthorized', 401)
  }

  const body = await res.json().catch(() => null)
  if (!res.ok) {
    throw new ApiError(body?.error ?? res.statusText, res.status, typeof body?.field === 'string' ? body.field : undefined)
  }
  return body as T
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body != null ? JSON.stringify(body) : undefined }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PUT', body: body != null ? JSON.stringify(body) : undefined }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
}

export function consumeRedirectTarget(fallback = '/'): string {
  const target = sessionStorage.getItem(REDIRECT_KEY)
  sessionStorage.removeItem(REDIRECT_KEY)
  return target ?? fallback
}

interface ApiState<T> {
  data: T | null
  loading: boolean
  error: string | null
  offline: boolean
}

// useApi — GET a path, tracking loading/error/offline/data. Pass null to
// skip. `offline` (network-unreachable, no HTTP response at all) is distinct
// from `error` (server responded with a failure) — DESIGN.md §6 renders
// OfflineBlock vs ErrorBlock accordingly.
export function useApi<T>(path: string | null): ApiState<T> & { refetch: () => void } {
  const [state, setState] = useState<ApiState<T>>({ data: null, loading: path != null, error: null, offline: false })

  const refetch = useCallback(() => {
    if (!path) return
    setState((s) => ({ ...s, loading: true, error: null, offline: false }))
    api
      .get<T>(path)
      .then((data) => setState({ data, loading: false, error: null, offline: false }))
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 401) return // redirect already in flight
        if (err instanceof NetworkError) {
          setState({ data: null, loading: false, error: null, offline: true })
          return
        }
        setState({ data: null, loading: false, error: err instanceof Error ? err.message : String(err), offline: false })
      })
  }, [path])

  useEffect(() => {
    refetch()
  }, [refetch])

  return { ...state, refetch }
}
