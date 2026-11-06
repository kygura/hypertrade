import { describe, expect, test } from 'bun:test'
import { ApiError, NetworkError } from './api'
import { loadFromHl, loadLatestPage } from './candles'

const HOUR = 3_600_000
const NOW = Date.UTC(2026, 10, 3, 12)
const T0 = NOW - 5 * HOUR

/** Canned HL info API: five 1h candles and an hourly funding settlement for each. */
function hlFetch(calls: string[] = []): typeof fetch {
  return (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { type: string; startTime?: number }
    calls.push(body.type)
    if (body.type === 'candleSnapshot') {
      const rows = [0, 1, 2, 3, 4].map((i) => {
        const t = T0 + i * HOUR
        return { t, T: t + HOUR - 1, o: '100', h: '102', l: '99', c: '101', v: '10' }
      })
      return Response.json(rows)
    }
    if (body.type === 'fundingHistory') {
      const rows = [1, 2, 3, 4, 5].map((i) => ({ coin: 'ETH', fundingRate: '0.0000125', premium: '0.0003', time: T0 + i * HOUR }))
      return Response.json(rows.filter((r) => r.time >= (body.startTime ?? 0)))
    }
    return new Response('unexpected', { status: 400 })
  }) as unknown as typeof fetch
}

describe('loadFromHl', () => {
  test('joins funding and premium onto HL candles; no OI, no older pages', async () => {
    const r = await loadFromHl('ETH', '1h', { fetch: hlFetch(), now: () => NOW })
    expect(r.bars).toHaveLength(5)
    expect(r.bars.every((b) => b.src === 'hl')).toBe(true)
    expect(r.bars[0]).toMatchObject({ t: T0, o: 100, c: 101, f: 0.0000125, p: 0.0003, oi: null })
    expect(r.hasMore).toBe(false)
    expect(r.funding).toEqual({ from: T0 + HOUR, complete: false })
    expect(r.oi).toEqual({ from: null })
  })

  test('a short funding page stops paging', async () => {
    const calls: string[] = []
    await loadFromHl('ETH', '1h', { fetch: hlFetch(calls), now: () => NOW })
    expect(calls.filter((c) => c === 'fundingHistory')).toHaveLength(1)
  })
})

describe('loadLatestPage', () => {
  const hl = { fetch: hlFetch(), now: () => NOW }
  const quiet = <T>(fn: () => Promise<T>) => {
    const warn = console.warn
    console.warn = () => {}
    return fn().finally(() => (console.warn = warn))
  }

  test('API answers: source api', async () => {
    const resp = { coin: 'ETH', tf: '1h' as const, bars: [], hasMore: true, error: null, funding: { from: null, complete: false }, oi: { from: null } }
    const r = await loadLatestPage('ETH', '1h', { get: async () => resp, hl })
    expect(r).toEqual({ resp, source: 'api' })
  })

  test('API 500 falls back to HL with f and p filled', async () => {
    const r = await quiet(() =>
      loadLatestPage('ETH', '1h', {
        get: async () => {
          throw new ApiError('database unavailable', 500)
        },
        hl,
      }),
    )
    expect(r.source).toBe('hl')
    expect(r.resp.bars.every((b) => b.f != null && b.p != null)).toBe(true)
  })

  test('network error falls back to HL', async () => {
    const r = await quiet(() =>
      loadLatestPage('ETH', '1h', {
        get: async () => {
          throw new NetworkError('down')
        },
        hl,
      }),
    )
    expect(r.source).toBe('hl')
  })

  test('401 does not fall back', async () => {
    const err = new ApiError('unauthorized', 401)
    const p = loadLatestPage('ETH', '1h', {
      get: async () => {
        throw err
      },
      hl,
    })
    await expect(p).rejects.toBe(err)
  })

  test('HL failing too rethrows the API error', async () => {
    const err = new NetworkError('down')
    const broken = (async () => new Response('bad', { status: 400 })) as unknown as typeof fetch
    const p = quiet(() =>
      loadLatestPage('ETH', '1h', {
        get: async () => {
          throw err
        },
        hl: { fetch: broken, now: () => NOW },
      }),
    )
    await expect(p).rejects.toBe(err)
  })
})
