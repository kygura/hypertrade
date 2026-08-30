import { useCallback, useEffect, useState } from 'react'

// Tiny fetch wrapper — JSON in/out, credentials included, 401 redirects to
// /login (SPEC.md: "Frontend route guard redirects to /login"). The intended
// path is remembered so LoginForm can return there on success.

export class ApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

const REDIRECT_KEY = 'ht_redirect_to'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    ...init,
  })

  if (res.status === 401 && path !== '/auth/login') {
    sessionStorage.setItem(REDIRECT_KEY, location.pathname)
    location.href = '/login'
    throw new ApiError('unauthorized', 401)
  }

  const body = await res.json().catch(() => null)
  if (!res.ok) {
    throw new ApiError(body?.error ?? res.statusText, res.status)
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
}

// useApi — GET a path, tracking loading/error/data. Pass null to skip.
export function useApi<T>(path: string | null): ApiState<T> & { refetch: () => void } {
  const [state, setState] = useState<ApiState<T>>({ data: null, loading: path != null, error: null })

  const refetch = useCallback(() => {
    if (!path) return
    setState((s) => ({ ...s, loading: true, error: null }))
    api
      .get<T>(path)
      .then((data) => setState({ data, loading: false, error: null }))
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 401) return // redirect already in flight
        setState({ data: null, loading: false, error: err instanceof Error ? err.message : String(err) })
      })
  }, [path])

  useEffect(() => {
    refetch()
  }, [refetch])

  return { ...state, refetch }
}
