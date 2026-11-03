import { useEffect, useState, useSyncExternalStore } from 'react'
import type { MarketRow, MarketsResponse } from '../../server/routes/hl'
import {
  fetchFundingPage,
  fetchPerpMetaAndCtxs,
  fetchPerpsAtOpenInterestCap,
  fetchPredictedFundings,
  type FundingPoint,
  type PredictedFunding,
} from '../../shared/hl-client'
import type { AssetCtx } from '../../shared/types'
import { api, ApiError } from './api'

// Live Hyperliquid data read straight from the browser (HL's public info API),
// so the market pages render with no backend state. One module-level poller
// is shared by every component through useSyncExternalStore: the landing page
// and the coin page never double-poll. Asset contexts refresh every 15s,
// predicted fundings and the at-cap list every 60s; polling pauses while the
// tab is hidden and the last good snapshot is kept through failures. When the
// direct call fails (CORS, 429), /api/hl/markets serves the same contexts
// from its 60s server cache.

export const CTX_MS = 15_000
export const SLOW_MS = 60_000
/** Timers can fire a little late or early; a tick this close to due counts as due. */
const SLACK_MS = 1_000

export interface UniverseState {
  ctxs: AssetCtx[]
  predicted: Map<string, PredictedFunding[]>
  atCap: string[]
  /** When the contexts were fetched upstream (ms), null before the first success. */
  updatedAt: number | null
  error: string | null
  loading: boolean
}

export const UNIVERSE_INITIAL: UniverseState = {
  ctxs: [],
  predicted: new Map(),
  atCap: [],
  updatedAt: null,
  error: null,
  loading: true,
}

/** True when a poll last started at `last` should run again at `now`. Pure. */
export function isDue(last: number | null, now: number, everyMs: number): boolean {
  return last == null || now - last >= everyMs - SLACK_MS
}

/** /hl/markets rows back to asset contexts. Fields the route drops come back as neutral defaults. Pure. */
export function ctxsFromMarkets(rows: MarketRow[]): AssetCtx[] {
  return rows.map((r) => ({
    name: r.coin,
    szDecimals: 0,
    markPx: r.markPx,
    oraclePx: r.oraclePx,
    midPx: r.markPx,
    dayNtlVlm: r.dayNtlVlm,
    prevDayPx: r.dayChangePct > -1 ? r.markPx / (1 + r.dayChangePct) : 0,
    openInterest: r.markPx > 0 ? r.openInterestUsd / r.markPx : 0,
    funding: r.funding,
    premium: r.premium,
    dayChange: r.dayChangePct,
    isDelisted: false,
    ...(r.maxLeverage != null ? { maxLeverage: r.maxLeverage } : {}),
    impactBidPx: null,
    impactAskPx: null,
  }))
}

export interface UniverseDeps {
  fetchCtxs: () => Promise<AssetCtx[]>
  fetchFallback: () => Promise<{ ctxs: AssetCtx[]; fetchedAt: number }>
  fetchPredicted: () => Promise<Map<string, PredictedFunding[]>>
  fetchAtCap: () => Promise<string[]>
  now: () => number
  hidden: () => boolean
}

const message = (err: unknown) => (err instanceof Error && err.message ? err.message : String(err))

/** The poller's state machine, I/O injected. `tick` runs whatever is due; the browser wiring lives in `start`. */
export function createUniverseStore(deps: UniverseDeps) {
  let state = UNIVERSE_INITIAL
  let lastCtx: number | null = null
  let lastSlow: number | null = null
  let ticking = false
  const listeners = new Set<() => void>()

  const set = (patch: Partial<UniverseState>) => {
    state = { ...state, ...patch }
    for (const l of listeners) l()
  }

  async function loadCtxs() {
    try {
      const ctxs = await deps.fetchCtxs()
      set({ ctxs, updatedAt: deps.now(), error: null, loading: false })
      return
    } catch (direct) {
      try {
        const fb = await deps.fetchFallback()
        set({ ctxs: fb.ctxs, updatedAt: fb.fetchedAt, error: null, loading: false })
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return // login redirect in flight
        set({ error: `Hyperliquid unreachable: ${message(direct)}`, loading: false })
      }
    }
  }

  async function loadSlow() {
    const [predicted, atCap] = await Promise.allSettled([deps.fetchPredicted(), deps.fetchAtCap()])
    const patch: Partial<UniverseState> = {}
    if (predicted.status === 'fulfilled') patch.predicted = predicted.value
    if (atCap.status === 'fulfilled') patch.atCap = atCap.value
    if (Object.keys(patch).length > 0) set(patch)
  }

  /** Runs every poll that is due; skipped while hidden or while the previous tick is in flight. */
  async function tick() {
    if (ticking || deps.hidden()) return
    ticking = true
    try {
      const now = deps.now()
      const jobs: Promise<void>[] = []
      if (isDue(lastCtx, now, CTX_MS)) {
        lastCtx = now
        jobs.push(loadCtxs())
      }
      if (isDue(lastSlow, now, SLOW_MS)) {
        lastSlow = now
        jobs.push(loadSlow())
      }
      await Promise.all(jobs)
    } finally {
      ticking = false
    }
  }

  let stop: (() => void) | null = null

  /** Browser wiring: a 15s timer that stops while the tab is hidden, plus one tick on showing. */
  function start() {
    let timer: ReturnType<typeof setInterval> | null = null
    const run = () => {
      if (timer == null) timer = setInterval(() => void tick(), CTX_MS)
      void tick()
    }
    const halt = () => {
      if (timer != null) clearInterval(timer)
      timer = null
    }
    const onVisibility = () => (deps.hidden() ? halt() : run())
    if (!deps.hidden()) run()
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility)
    return () => {
      halt()
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility)
    }
  }

  return {
    tick,
    getSnapshot: () => state,
    /** First subscriber starts the poller, last one stops it; the snapshot survives for the next mount. */
    subscribe(listener: () => void) {
      listeners.add(listener)
      if (listeners.size === 1) stop = start()
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0 && stop) {
          stop()
          stop = null
        }
      }
    },
  }
}

const universe = createUniverseStore({
  fetchCtxs: async () => (await fetchPerpMetaAndCtxs()).ctxs,
  fetchFallback: async () => {
    const r = await api.get<MarketsResponse>('/hl/markets')
    return { ctxs: ctxsFromMarkets(r.markets), fetchedAt: Date.parse(r.fetchedAt) }
  },
  fetchPredicted: () => fetchPredictedFundings(),
  fetchAtCap: () => fetchPerpsAtOpenInterestCap(),
  now: () => Date.now(),
  hidden: () => typeof document !== 'undefined' && document.hidden,
})

/** The live main-dex universe: contexts, predicted fundings per venue and the at-cap list. */
export function useLiveUniverse(): UniverseState {
  return useSyncExternalStore(universe.subscribe, universe.getSnapshot, universe.getSnapshot)
}

// ─── funding grid ───

export const FUNDING_TTL_MS = 10 * 60_000
const HOUR = 3_600_000

export interface FundingCacheEntry {
  at: number
  points: FundingPoint[]
}

/** The getItem/setItem slice of Web Storage; either may throw (blocked or full storage). */
export interface KV {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export const fundingKey = (coin: string, hours: number) => `ht_funding:${coin}:${hours}`

/** Fresh cached points for `key` from memory, else from storage (promoted to memory); null when missing or stale. */
export function readFundingCache(
  mem: Map<string, FundingCacheEntry>,
  storage: KV | null,
  key: string,
  now: number,
  ttl: number = FUNDING_TTL_MS,
): FundingPoint[] | null {
  const fresh = (e: FundingCacheEntry | undefined): e is FundingCacheEntry => e != null && now - e.at < ttl && now >= e.at
  const hit = mem.get(key)
  if (fresh(hit)) return hit.points
  try {
    const raw = storage?.getItem(key)
    if (!raw) return null
    const e = JSON.parse(raw) as FundingCacheEntry
    if (typeof e?.at !== 'number' || !Array.isArray(e.points) || !fresh(e)) return null
    mem.set(key, e)
    return e.points
  } catch {
    return null
  }
}

export function writeFundingCache(mem: Map<string, FundingCacheEntry>, storage: KV | null, key: string, entry: FundingCacheEntry) {
  mem.set(key, entry)
  try {
    storage?.setItem(key, JSON.stringify(entry))
  } catch {
    // blocked or full storage: the memory copy still serves this visit
  }
}

export interface FundingGridDeps {
  fetchPage: (coin: string, startTime: number) => Promise<FundingPoint[]>
  now: () => number
  mem: Map<string, FundingCacheEntry>
  storage: KV | null
  /** Called as each coin resolves (cached or fetched). */
  onCoin: (coin: string, points: FundingPoint[]) => void
  onError: (coin: string, err: unknown) => void
  cancelled: () => boolean
}

/** Cached coins first, then one fetchFundingPage per missing coin, strictly one at a time. */
export async function loadFundingGrid(coins: string[], hours: number, deps: FundingGridDeps): Promise<void> {
  const missing: string[] = []
  for (const coin of coins) {
    const hit = readFundingCache(deps.mem, deps.storage, fundingKey(coin, hours), deps.now())
    if (hit) deps.onCoin(coin, hit)
    else missing.push(coin)
  }
  for (const coin of missing) {
    if (deps.cancelled()) return
    try {
      const now = deps.now()
      const points = await deps.fetchPage(coin, now - hours * HOUR)
      if (deps.cancelled()) return
      writeFundingCache(deps.mem, deps.storage, fundingKey(coin, hours), { at: now, points })
      deps.onCoin(coin, points)
    } catch (err) {
      if (deps.cancelled()) return
      deps.onError(coin, err)
    }
  }
}

const fundingMem = new Map<string, FundingCacheEntry>()

function sessionKV(): KV | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage
  } catch {
    return null
  }
}

export interface FundingGrid {
  /** Hourly settlements per coin, ascending; coins appear as they load. */
  data: Map<string, FundingPoint[]>
  loading: boolean
  error: string | null
}

/** Last `hours` of hourly funding for each coin, re-read when the 10-minute cache expires. */
export function useFundingGrid(coins: string[], hours = 72): FundingGrid {
  const key = coins.join(',')
  const [grid, setGrid] = useState<FundingGrid>({ data: new Map(), loading: coins.length > 0, error: null })

  useEffect(() => {
    const list = key ? key.split(',') : []
    let cancelled = false
    const data = new Map<string, FundingPoint[]>()
    const run = async () => {
      if (typeof document !== 'undefined' && document.hidden) return
      let error: string | null = null
      setGrid((g) => ({ ...g, loading: list.length > 0 }))
      await loadFundingGrid(list, hours, {
        fetchPage: (coin, start) => fetchFundingPage(coin, start),
        now: () => Date.now(),
        mem: fundingMem,
        storage: sessionKV(),
        cancelled: () => cancelled,
        onCoin: (coin, points) => {
          data.set(coin, points)
          setGrid((g) => ({ ...g, data: new Map(data) }))
        },
        onError: (coin, err) => {
          error = `${coin}: ${message(err)}`
        },
      })
      if (!cancelled) setGrid({ data: new Map(data), loading: false, error })
    }
    setGrid({ data: new Map(), loading: list.length > 0, error: null })
    void run()
    const timer = setInterval(() => void run(), FUNDING_TTL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [key, hours])

  return grid
}
