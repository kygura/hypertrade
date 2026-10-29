import { afterEach, describe, expect, test } from 'bun:test'
import { NetworkError } from './api'
import { readSse, streamSse } from './sse'

const enc = new TextEncoder()
const streamOf = (chunks: string[], then?: () => void) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch))
      then ? then() : c.close()
    },
  })

describe('readSse', () => {
  test('emits frames split across chunks and skips malformed ones', async () => {
    const got: unknown[] = []
    await readSse(streamOf(['event: text\ndata: {"delta":"a"}\n\nevent: te', 'xt\ndata: nope\n\nevent: done\ndata: {"rounds":1}\n\n']), (e) => got.push(e))
    expect(got).toEqual([{ type: 'text', delta: 'a' }, { type: 'done', rounds: 1 }])
  })

  test('a read error after abort ends quietly, otherwise throws NetworkError', async () => {
    const failing = () =>
      new ReadableStream<Uint8Array>({
        pull() {
          throw new Error('boom')
        },
      })
    const ac = new AbortController()
    ac.abort()
    await expect(readSse(failing(), () => {}, ac.signal)).resolves.toBeUndefined()
    await expect(readSse(failing(), () => {})).rejects.toBeInstanceOf(NetworkError)
  })
})

describe('streamSse', () => {
  const realFetch = globalThis.fetch
  const mock = (f: typeof fetch) => {
    globalThis.fetch = f
  }
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  test('posts the body and streams events', async () => {
    let seen: { url: string; init?: RequestInit } | null = null
    mock((async (url: string, init?: RequestInit) => {
      seen = { url, init }
      return new Response(streamOf(['event: done\ndata: {"rounds":0}\n\n']))
    }) as unknown as typeof fetch)
    const got: unknown[] = []
    await streamSse('/api/x', { q: 1 }, (e) => got.push(e))
    expect(got).toEqual([{ type: 'done', rounds: 0 }])
    expect(seen!.url).toBe('/api/x')
    expect(seen!.init?.body).toBe('{"q":1}')
  })

  test('abort before the response resolves quietly; other fetch failures are NetworkError', async () => {
    const ac = new AbortController()
    mock((async () => {
      ac.abort()
      throw new Error('aborted')
    }) as unknown as typeof fetch)
    await expect(streamSse('/api/x', {}, () => {}, ac.signal)).resolves.toBeUndefined()
    mock((async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch)
    await expect(streamSse('/api/x', {}, () => {})).rejects.toBeInstanceOf(NetworkError)
  })

  test('non-2xx surfaces the server error as ApiError', async () => {
    mock((async () => new Response(JSON.stringify({ error: 'not configured' }), { status: 503 })) as unknown as typeof fetch)
    await expect(streamSse('/api/x', {}, () => {})).rejects.toMatchObject({ status: 503, message: 'not configured' })
  })
})
