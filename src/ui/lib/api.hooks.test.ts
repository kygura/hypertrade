import { describe, expect, test } from 'bun:test'
import { ApiError, NetworkError, apiFailed, makeSequencer } from './api'
import { makeLoadGate, pollInitial } from './poll'

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

describe('makeLoadGate (refetch during an in-flight poll)', () => {
  test('a refetch queues one more load and makes the in-flight result stale', () => {
    const g = makeLoadGate()
    const t1 = g.start()
    expect(t1).not.toBeNull()
    expect(g.start(true)).toBeNull()
    expect(g.start(true)).toBeNull()
    expect(g.seq.isCurrent(t1!)).toBe(false)
    expect(g.end(t1!)).toBe(true)
    const t2 = g.start(true)
    expect(t2).not.toBeNull()
    expect(g.seq.isCurrent(t2!)).toBe(true)
    expect(g.end(t2!)).toBe(false)
  })
  test('an interval tick during a load is a no-op and keeps the result current', () => {
    const g = makeLoadGate()
    const t = g.start()!
    expect(g.start()).toBeNull()
    expect(g.seq.isCurrent(t)).toBe(true)
    expect(g.end(t)).toBe(false)
  })
  test('reset drops the in-flight load and any queued refetch', () => {
    const g = makeLoadGate()
    const t = g.start()!
    g.start(true)
    g.reset()
    expect(g.end(t)).toBe(false)
    expect(g.start()).not.toBeNull()
  })
})
