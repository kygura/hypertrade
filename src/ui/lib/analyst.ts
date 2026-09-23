import { ApiError, NetworkError } from './api'

// Client for /api/analyst (SPEC.md "Analyst"). The query endpoint is a POST
// that answers with text/event-stream, so EventSource (GET-only) does not
// fit; this reads the fetch body and splits SSE frames by hand. 401 follows
// api.ts's redirect-to-login rule; 503/502 surface as ApiError so the page
// can render its offline states.

export interface AnalystCitation {
  url: string
  title: string | null
  cited_text?: string
}

export interface AnalystUsage {
  input_tokens: number
  output_tokens: number
}

export type AnalystStreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown; server: boolean }
  | { type: 'tool_result'; id: string; name: string; ok: boolean; summary: string }
  | { type: 'citations'; citations: AnalystCitation[] }
  | { type: 'error'; error: string }
  | { type: 'done'; usage: AnalystUsage; model: string; provider: string; rounds: number; stop: string }

export interface AnalystStatus {
  configured: boolean
  provider: string
  model: string
  web_search: boolean
  tools: Array<{ name: string; available: boolean; note?: string }>
}

export interface HistoryTurn {
  role: 'user' | 'assistant'
  content: string
}

const REDIRECT_KEY = 'ht_redirect_to'

async function failFrom(res: Response): Promise<never> {
  if (res.status === 401) {
    sessionStorage.setItem(REDIRECT_KEY, location.pathname)
    location.href = '/login'
    throw new ApiError('unauthorized', 401)
  }
  const body = (await res.json().catch(() => null)) as { error?: string } | null
  throw new ApiError(body?.error ?? res.statusText, res.status)
}

export async function getAnalystStatus(): Promise<AnalystStatus> {
  let res: Response
  try {
    res = await fetch('/api/analyst/status', { credentials: 'include' })
  } catch (err) {
    throw new NetworkError(err instanceof Error ? err.message : 'network unreachable')
  }
  if (!res.ok) return failFrom(res)
  return (await res.json()) as AnalystStatus
}

/** Splits an SSE text buffer into complete frames; returns [frames, rest]. */
export function splitFrames(buf: string): [Array<{ event: string; data: string }>, string] {
  const frames: Array<{ event: string; data: string }> = []
  let rest = buf.replace(/\r\n/g, '\n')
  let idx: number
  while ((idx = rest.indexOf('\n\n')) >= 0) {
    const raw = rest.slice(0, idx)
    rest = rest.slice(idx + 2)
    let event = 'message'
    const data: string[] = []
    for (const line of raw.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
    }
    if (data.length) frames.push({ event, data: data.join('\n') })
  }
  return [frames, rest]
}

/**
 * Streams one question. Calls onEvent for every server event in order and
 * resolves when the stream ends. Throws ApiError (503/502/4xx before the
 * stream starts) or NetworkError; an AbortSignal stops it quietly.
 */
export async function streamAnalyst(
  question: string,
  history: HistoryTurn[],
  onEvent: (e: AnalystStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  let res: Response
  try {
    res = await fetch('/api/analyst/query', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ question, history }),
      signal,
    })
  } catch (err) {
    if (signal?.aborted) return
    throw new NetworkError(err instanceof Error ? err.message : 'network unreachable')
  }
  if (!res.ok || !res.body) return failFrom(res)

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const [frames, rest] = splitFrames(buf)
      buf = rest
      for (const f of frames) {
        try {
          onEvent({ type: f.event, ...JSON.parse(f.data) } as AnalystStreamEvent)
        } catch {
          // A malformed frame is skipped; the done event still arrives.
        }
      }
    }
  } catch (err) {
    if (signal?.aborted) return
    throw new NetworkError(err instanceof Error ? err.message : 'stream interrupted')
  }
}
