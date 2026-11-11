import { describe, expect, test } from 'bun:test'
import type { QueueItem } from '../../../shared/queue'
import { ASK_MAX, askContextOf, withContext } from './context'

const item = (over: Partial<QueueItem> = {}): QueueItem =>
  ({
    id: '2026-11-11:SOL',
    day: '2026-11-11',
    coin: 'SOL',
    reason: 'residual +6.2% · z +3.1 · 24h · no news in window',
    score: 1.4,
    firstAt: '2026-11-11T08:00:00Z',
    lastAt: '2026-11-11T08:00:00Z',
    state: 'new',
    dismissedAt: null,
    parts: [],
    record: {
      claim: 'SOL leads on a funding squeeze',
      falsifier: { side: 'below', level: 142.5, text: 'x' },
    },
    href: '/coin/SOL',
    ...over,
  }) as unknown as QueueItem

describe('askContextOf', () => {
  test('path shapes give the coin', () => {
    expect(askContextOf('/coin/SOL', '')).toEqual({ coin: 'SOL' })
    expect(askContextOf('/markets/ETH', '')).toEqual({ coin: 'ETH' })
    expect(askContextOf('/asset/BTC', '')).toEqual({ coin: 'BTC' })
    expect(askContextOf('/coin/xyz%3ATSLA', '')).toEqual({ coin: 'xyz:TSLA' })
    expect(askContextOf('/queue', '?coin=SOL')).toEqual({ coin: 'SOL' })
    expect(askContextOf('/moves', '?window=24h&coin=HYPE')).toEqual({ coin: 'HYPE' })
    expect(askContextOf('/board', '?coin=BTC')).toEqual({ coin: 'BTC' })
  })
  test('anything else is null', () => {
    expect(askContextOf('/queue', '')).toBeNull()
    expect(askContextOf('/analyst', '?coin=SOL')).toBeNull()
    expect(askContextOf('/coin', '')).toBeNull()
    expect(askContextOf('/coin/not a coin!', '')).toBeNull()
  })
})

describe('withContext', () => {
  test('no context, no prefix', () => {
    expect(withContext('why?', null)).toBe('why?')
  })
  test('coin only', () => {
    expect(withContext('why?', { coin: 'SOL' })).toBe('[context: coin SOL]\nwhy?')
  })
  test('item facts, and no number absent from the item', () => {
    const it = item()
    const out = withContext('why?', { coin: 'SOL', item: it })
    expect(out).toContain('in queue: residual +6.2%')
    expect(out).toContain('agent record: SOL leads')
    expect(out).toContain('falsifier below 142.5')
    const known = JSON.stringify(it) + 'why?'
    for (const n of out.match(/\d+(\.\d+)?/g) ?? []) expect(known).toContain(n)
  })
  test('whole text stays within the route max', () => {
    const long = item({ reason: 'r'.repeat(200), record: { claim: 'c'.repeat(400), falsifier: null } as never })
    expect(withContext('q', { coin: 'SOL', item: long }).length).toBeLessThanOrEqual(ASK_MAX)
    const q = 'x'.repeat(ASK_MAX - 30)
    expect(withContext(q, { coin: 'SOL', item: long }).length).toBeLessThanOrEqual(ASK_MAX)
    const full = 'x'.repeat(ASK_MAX)
    expect(withContext(full, { coin: 'SOL', item: long })).toBe(full)
  })
})
