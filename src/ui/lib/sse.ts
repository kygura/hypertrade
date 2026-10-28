import { failFrom, NetworkError } from './api'

// POST + text/event-stream client shared by the analyst and desk streams.
// EventSource is GET-only, so this reads the fetch body and splits frames by hand.

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

/** Feeds every frame of an SSE body to onEvent as `{ type: event, ...json }`; a malformed frame is skipped. An abort ends it quietly. */
export async function readSse<E>(body: ReadableStream<Uint8Array>, onEvent: (e: E) => void, signal?: AbortSignal): Promise<void> {
  const reader = body.getReader()
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
          onEvent({ type: f.event, ...JSON.parse(f.data) } as E)
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

/**
 * POSTs `body` to `url` and streams the SSE answer. Throws ApiError (non-2xx before
 * the stream starts; 401 redirects to login) or NetworkError; an AbortSignal stops it quietly.
 */
export async function streamSse<E>(url: string, body: unknown, onEvent: (e: E) => void, signal?: AbortSignal): Promise<void> {
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(body),
      signal,
    })
  } catch (err) {
    if (signal?.aborted) return
    throw new NetworkError(err instanceof Error ? err.message : 'network unreachable')
  }
  if (!res.ok || !res.body) return failFrom(res)
  await readSse(res.body, onEvent, signal)
}
