import { describe, expect, test } from 'bun:test'
import type { MarketRow } from '../../server/routes/hl'
import type { FundingPoint } from '../../shared/hl-client'
import type { AssetCtx } from '../../shared/types'
import {
  CTX_MS,
  FUNDING_TTL_MS,
  SLOW_MS,
  createUniverseStore,
  ctxsFromMarkets,
  fundingKey,
  isDue,
  loadFundingGrid,
  readFundingCache,
  writeFundingCache,
  type FundingCacheEntry,
  type KV,
  type UniverseDeps,
} from './hlLive'

const ctx = (name: string, markPx = 10): AssetCtx => ({
  name,
  szDecimals: 0,
  markPx,
  oraclePx: markPx,
  midPx: markPx,
  dayNtlVlm: 5e6,
  prevDayPx: markPx,
  openInterest: 1e6,
  funding: 0.00001,
  premium: 0,
  dayChange: 0,
  isDelisted: false,
})

describe('isDue', () => {
  test('never polled is due', () => expect(isDue(null, 0, CTX_MS)).toBe(true))
  test('within the interval is not due', () => expect(isDue(1000, 1000 + CTX_MS / 2, CTX_MS)).toBe(false))
  test('a timer firing slightly early still counts', () => expect(isDue(0, CTX_MS - 200, CTX_MS)).toBe(true))
  test('a 15s tick is not a 60s tick', () => expect(isDue(0, CTX_MS, SLOW_MS)).toBe(false))
})

describe('ctxsFromMarkets', () => {
  test('maps /hl/markets rows back to contexts', () => {
    const row: MarketRow = {
      coin: 'ETH',
      markPx: 2000,
      oraclePx: 1999,
      premium: 0.0005,
      funding: 0.0000125,
      openInterestUsd: 400e6,
      dayNtlVlm: 900e6,
      dayChangePct: 0.25,
      dex: '',
      assetClass: 'crypto',
      maxLeverage: 25,
    }
    const [c] = ctxsFromMarkets([row])
    expect(c).toMatchObject({ name: 'ETH', markPx: 2000, oraclePx: 1999, openInterest: 200_000, prevDayPx: 1600, dayChange: 0.25, funding: 0.0000125, maxLeverage: 25, isDelisted: false })
  })
  test('zero mark price does not divide by zero', () => {
    const [c] = ctxsFromMarkets([{ coin: 'X', markPx: 0, oraclePx: 0, premium: 0, funding: 0, openInterestUsd: 0, dayNtlVlm: 0, dayChangePct: 0, dex: '', assetClass: 'crypto', maxLeverage: null }])
    expect(c!.openInterest).toBe(0)
    expect('maxLeverage' in c!).toBe(false)
  })
})

function harness(over: Partial<UniverseDeps> = {}) {
  let now = 1_000_000
  const calls = { ctxs: 0, fallback: 0, predicted: 0, atCap: 0 }
  const deps: UniverseDeps = {
    fetchCtxs: async () => {
      calls.ctxs++
      return [ctx('BTC')]
    },
    fetchFallback: async () => {
      calls.fallback++
      return { ctxs: [ctx('ETH')], fetchedAt: 42 }
    },
    fetchPredicted: async () => {
      calls.predicted++
      return new Map([['BTC', [{ venue: 'BinPerp', rate: 0.0001, intervalHours: 8, nextFundingTime: null }]]])
    },
    fetchAtCap: async () => {
      calls.atCap++
      return ['HYPE']
    },
    now: () => now,
    hidden: () => false,
    ...over,
  }
  const store = createUniverseStore(deps)
  return { store, calls, advance: (ms: number) => (now += ms), now: () => now }
}

describe('createUniverseStore', () => {
  test('first tick loads everything', async () => {
    const h = harness()
    await h.store.tick()
    const s = h.store.getSnapshot()
    expect(s.ctxs.map((c) => c.name)).toEqual(['BTC'])
    expect(s.atCap).toEqual(['HYPE'])
    expect(s.predicted.get('BTC')).toHaveLength(1)
    expect(s).toMatchObject({ loading: false, error: null, updatedAt: h.now() })
  })

  test('contexts every 15s, predicted and at-cap every 60s', async () => {
    const h = harness()
    await h.store.tick()
    for (let i = 0; i < 4; i++) {
      h.advance(CTX_MS)
      await h.store.tick()
    }
    expect(h.calls).toEqual({ ctxs: 5, fallback: 0, predicted: 2, atCap: 2 })
  })

  test('a tick before due fetches nothing', async () => {
    const h = harness()
    await h.store.tick()
    h.advance(5_000)
    await h.store.tick()
    expect(h.calls.ctxs).toBe(1)
  })

  test('paused while hidden', async () => {
    const h = harness({ hidden: () => true })
    await h.store.tick()
    expect(h.calls).toEqual({ ctxs: 0, fallback: 0, predicted: 0, atCap: 0 })
    expect(h.store.getSnapshot().loading).toBe(true)
  })

  test('a failed direct call falls back to /hl/markets with its fetchedAt', async () => {
    const h = harness({
      fetchCtxs: async () => {
        throw new Error('HL 429')
      },
    })
    await h.store.tick()
    const s = h.store.getSnapshot()
    expect(s.ctxs.map((c) => c.name)).toEqual(['ETH'])
    expect(s.updatedAt).toBe(42)
    expect(s.error).toBeNull()
  })

  test('both failing keeps the last good snapshot and surfaces the error', async () => {
    let fail = false
    const h = harness({
      fetchCtxs: async () => {
        if (fail) throw new Error('HL 429')
        return [ctx('BTC')]
      },
      fetchFallback: async () => {
        throw new Error('no api')
      },
      fetchAtCap: async () => {
        if (fail) throw new Error('HL 429')
        return ['HYPE']
      },
    })
    await h.store.tick()
    const good = h.store.getSnapshot().updatedAt
    fail = true
    h.advance(SLOW_MS)
    await h.store.tick()
    const s = h.store.getSnapshot()
    expect(s.ctxs.map((c) => c.name)).toEqual(['BTC'])
    expect(s.atCap).toEqual(['HYPE'])
    expect(s.updatedAt).toBe(good)
    expect(s.error).toContain('HL 429')
  })

  test('the snapshot reference only changes on an update', async () => {
    const h = harness()
    const a = h.store.getSnapshot()
    expect(h.store.getSnapshot()).toBe(a)
    await h.store.tick()
    expect(h.store.getSnapshot()).not.toBe(a)
  })
})

const pts = (n: number): FundingPoint[] => Array.from({ length: n }, (_, i) => ({ t: i, rate: 0.00001, premium: 0 }))

function memKV(): KV & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) }
}

const throwingKV: KV = {
  getItem: () => {
    throw new Error('SecurityError')
  },
  setItem: () => {
    throw new Error('QuotaExceededError')
  },
}

describe('funding cache', () => {
  const key = fundingKey('ETH', 72)

  test('fresh memory entry hits', () => {
    const mem = new Map<string, FundingCacheEntry>([[key, { at: 0, points: pts(2) }]])
    expect(readFundingCache(mem, null, key, FUNDING_TTL_MS - 1)).toHaveLength(2)
  })

  test('expired entry misses', () => {
    const mem = new Map<string, FundingCacheEntry>([[key, { at: 0, points: pts(2) }]])
    expect(readFundingCache(mem, null, key, FUNDING_TTL_MS)).toBeNull()
  })

  test('storage entry hits and is promoted to memory', () => {
    const kv = memKV()
    writeFundingCache(new Map(), kv, key, { at: 100, points: pts(3) })
    const mem = new Map<string, FundingCacheEntry>()
    expect(readFundingCache(mem, kv, key, 200)).toHaveLength(3)
    expect(mem.get(key)?.at).toBe(100)
  })

  test('corrupt storage entry misses', () => {
    const kv = memKV()
    kv.data.set(key, '{not json')
    expect(readFundingCache(new Map(), kv, key, 0)).toBeNull()
    kv.data.set(key, JSON.stringify({ at: 'x', points: [] }))
    expect(readFundingCache(new Map(), kv, key, 0)).toBeNull()
  })

  test('throwing storage is ignored on read and write', () => {
    const mem = new Map<string, FundingCacheEntry>()
    expect(() => writeFundingCache(mem, throwingKV, key, { at: 0, points: pts(1) })).not.toThrow()
    expect(readFundingCache(mem, throwingKV, key, 1)).toHaveLength(1)
    expect(readFundingCache(new Map(), throwingKV, key, 1)).toBeNull()
  })
})

describe('loadFundingGrid', () => {
  test('cached coins skip the network; misses fetch one at a time', async () => {
    const mem = new Map<string, FundingCacheEntry>([[fundingKey('BTC', 72), { at: 0, points: pts(1) }]])
    let active = 0
    let maxActive = 0
    const fetched: string[] = []
    const got: string[] = []
    await loadFundingGrid(['BTC', 'ETH', 'SOL'], 72, {
      fetchPage: async (coin) => {
        active++
        maxActive = Math.max(maxActive, active)
        await new Promise((r) => setTimeout(r, 1))
        active--
        fetched.push(coin)
        return pts(72)
      },
      now: () => 1000,
      mem,
      storage: null,
      onCoin: (coin) => got.push(coin),
      onError: () => {},
      cancelled: () => false,
    })
    expect(fetched).toEqual(['ETH', 'SOL'])
    expect(got).toEqual(['BTC', 'ETH', 'SOL'])
    expect(maxActive).toBe(1)
    expect(mem.get(fundingKey('SOL', 72))?.points).toHaveLength(72)
  })

  test('one failing coin does not stop the rest', async () => {
    const errs: string[] = []
    const got: string[] = []
    await loadFundingGrid(['BAD', 'ETH'], 72, {
      fetchPage: async (coin) => {
        if (coin === 'BAD') throw new Error('HL 500')
        return pts(1)
      },
      now: () => 0,
      mem: new Map(),
      storage: null,
      onCoin: (coin) => got.push(coin),
      onError: (coin) => errs.push(coin),
      cancelled: () => false,
    })
    expect(errs).toEqual(['BAD'])
    expect(got).toEqual(['ETH'])
  })

  test('cancellation stops further fetches', async () => {
    let cancelled = false
    const fetched: string[] = []
    await loadFundingGrid(['A', 'B', 'C'], 72, {
      fetchPage: async (coin) => {
        fetched.push(coin)
        cancelled = true
        return pts(1)
      },
      now: () => 0,
      mem: new Map(),
      storage: null,
      onCoin: () => {},
      onError: () => {},
      cancelled: () => cancelled,
    })
    expect(fetched).toEqual(['A'])
  })

  test('the requested window starts `hours` back', async () => {
    let start = -1
    await loadFundingGrid(['ETH'], 72, {
      fetchPage: async (_c, s) => {
        start = s
        return []
      },
      now: () => 100 * 3_600_000,
      mem: new Map(),
      storage: null,
      onCoin: () => {},
      onError: () => {},
      cancelled: () => false,
    })
    expect(start).toBe(28 * 3_600_000)
  })
})
