import { describe, expect, test } from 'bun:test'
import { MarkSampler, pickMark, upnlAt } from './liveMarks'

describe('MarkSampler', () => {
  test('throttles to one snapshot per interval, carrying the newest mid at emit time', () => {
    let t = 1_000
    const s = new MarkSampler(3_000, () => t)
    expect(s.offer({ BTC: '60000', ETH: '3000' }, ['BTC'])).toEqual({ BTC: { px: 60000, at: 1_000 } })
    t = 2_000
    expect(s.offer({ BTC: '60010' }, ['BTC'])).toBeNull()
    t = 3_999
    expect(s.offer({ BTC: '60020' }, ['BTC'])).toBeNull()
    t = 4_000
    expect(s.offer({ BTC: '60030' }, ['BTC'])).toEqual({ BTC: { px: 60030, at: 4_000 } })
  })

  test('keeps the latest mid seen between emits; ignores coins not asked for and bad values', () => {
    let t = 0
    const s = new MarkSampler(3_000, () => t)
    expect(s.offer({ ETH: '3000' }, ['BTC'])).toBeNull()
    t = 1_000
    expect(s.offer({ BTC: 'NaN' }, ['BTC'])).toBeNull()
    t = 1_500
    expect(s.offer({ BTC: '61000' }, ['BTC'])).toEqual({ BTC: { px: 61000, at: 1_500 } })
    t = 2_000
    s.offer({ BTC: '61100' }, ['BTC'])
    t = 4_600
    expect(s.offer({}, ['BTC'])).toEqual({ BTC: { px: 61100, at: 4_600 } })
  })

  test('a 1 s tick stream for 30 s yields 10 snapshots, not 30', () => {
    let t = 0
    const s = new MarkSampler(3_000, () => t)
    let n = 0
    for (; t < 30_000; t += 1_000) if (s.offer({ BTC: String(60000 + t) }, ['BTC'])) n++
    expect(n).toBe(10)
  })
})

describe('pickMark', () => {
  test('a fresh live sample wins; a stale or missing one falls back to the polled mark', () => {
    expect(pickMark({ px: 101, at: 10_000 }, 100, 20_000)).toEqual({ px: 101, live: true })
    expect(pickMark({ px: 101, at: 10_000 }, 100, 26_000)).toEqual({ px: 100, live: false })
    expect(pickMark(undefined, 100, 0)).toEqual({ px: 100, live: false })
  })
})

describe('upnlAt', () => {
  test('signed for the side', () => {
    expect(upnlAt({ side: 'long', size: 2, entryPx: 100 }, 105)).toBe(10)
    expect(upnlAt({ side: 'short', size: 2, entryPx: 100 }, 105)).toBe(-10)
  })
})
