import { describe, expect, test } from 'bun:test'
import { ApiError, NetworkError, apiFailed, makeSequencer } from './api'
import { pollInitial } from './poll'

describe('makeSequencer (latest-wins)', () => {
  test('only the newest ticket is current', () => {
    const s = makeSequencer()
    const slow = s.next()
    const fast = s.next()
    expect(s.isCurrent(slow)).toBe(false)
    expect(s.isCurrent(fast)).toBe(true)
  })
})

describe('apiFailed (keep last good data)', () => {
  const prev = { data: { n: 1 }, loading: true, error: null, offline: false }
  test('server error keeps data and exposes the message', () => {
    expect(apiFailed(prev, new ApiError('boom', 500))).toEqual({ data: { n: 1 }, loading: false, error: 'boom', offline: false })
  })
  test('network error keeps data and flags offline', () => {
    expect(apiFailed(prev, new NetworkError('down'))).toEqual({ data: { n: 1 }, loading: false, error: null, offline: true })
  })
})

describe('pollInitial (reset-on-deps)', () => {
  test('has no data from a previous key', () => {
    expect(pollInitial(true)).toEqual({ data: null, loading: true, error: null, offline: null, fetchedAt: null })
    expect(pollInitial(false).loading).toBe(false)
  })
})
