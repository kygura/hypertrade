import { beforeEach, describe, expect, test } from 'bun:test'
import { CACHE_MAX_AGE_MS, cacheClear, cacheGet, cacheSet, shared } from './cache'
import { apiInitial } from './api'
import { pollInitial } from './poll'

beforeEach(cacheClear)

describe('response cache', () => {
  test('returns what was stored, with its arrival time', () => {
    cacheSet('/queue', { n: 1 }, 1000)
    expect(cacheGet('/queue', 2000)).toEqual({ data: { n: 1 }, at: 1000 })
  })
  test('an entry past the max age is never shown', () => {
    cacheSet('/queue', { n: 1 }, 1000)
    expect(cacheGet('/queue', 1000 + CACHE_MAX_AGE_MS + 1)).toBeNull()
  })
  test('no key, no cache', () => {
    cacheSet(null, { n: 1 })
    expect(cacheGet(null)).toBeNull()
    expect(cacheGet(undefined)).toBeNull()
  })
  test('cacheClear drops everything (login, logout, 401)', () => {
    cacheSet('/queue', { n: 1 })
    cacheClear()
    expect(cacheGet('/queue')).toBeNull()
  })
})

describe('shared (in-flight de-duplication)', () => {
  test('concurrent callers share one request; the next call after it settles fetches again', async () => {
    let calls = 0
    const load = async () => ++calls
    const [a, b] = await Promise.all([shared('/auth/me', load), shared('/auth/me', load)])
    expect([a, b, calls]).toEqual([1, 1, 1])
    expect(await shared('/auth/me', load)).toBe(2)
  })
  test('a failure is shared and does not stick', async () => {
    let calls = 0
    const load = async () => {
      if (++calls === 1) throw new Error('boom')
      return 'ok'
    }
    await expect(shared('/x', load)).rejects.toThrow('boom')
    expect(await shared('/x', load)).toBe('ok')
  })
})

describe('hooks start from the cache', () => {
  test('useApi: a cached path paints its data while the refetch runs', () => {
    expect(apiInitial('/sectors')).toEqual({ data: null, loading: true, error: null, offline: false })
    cacheSet('/sectors', { rows: [] })
    expect(apiInitial('/sectors')).toEqual({ data: { rows: [] }, loading: true, error: null, offline: false })
    expect(apiInitial(null)).toEqual({ data: null, loading: false, error: null, offline: false })
  })
  test('usePoll: a cacheKey seeds data and its age; no key keeps the empty start', () => {
    const at = Date.now()
    cacheSet('queue', { items: [] }, at)
    expect(pollInitial<unknown>(true, 'queue')).toEqual({ data: { items: [] }, loading: false, error: null, offline: null, fetchedAt: at })
    expect(pollInitial(true)).toEqual({ data: null, loading: true, error: null, offline: null, fetchedAt: null })
    expect(pollInitial(true, 'other')).toEqual({ data: null, loading: true, error: null, offline: null, fetchedAt: null })
  })
})
