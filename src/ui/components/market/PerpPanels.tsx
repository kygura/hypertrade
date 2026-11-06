import { useEffect, useMemo, useState } from 'react'
import { classForPnl, fmtPct, fmtPrice, fmtUsd } from '../../../shared/format'
import type { FundingPoint, PredictedFunding } from '../../../shared/hl-client'
import { fundingApr, type PerpStats } from '../../../shared/market'
import { venueApr } from '../../../shared/marketRead'
import { useApi } from '../../lib/api'
import { useFundingGrid, useLiveUniverse, type UniverseState } from '../../lib/hlLive'
import { useHlSubscription, type WsAssetCtx } from '../../lib/hlWs'
import { useNow } from '../../lib/hooks'
import { AnimatedDigits } from '../AnimatedDigits'
import { Badge } from '../Badge'
import { MetricStat } from '../MetricStat'
import { PanelHeader } from '../Panel'
import { AgeStamp, AsyncBody } from '../state'

// Perp context for the markets drill-in: everything Hyperliquid exposes
// about one perp beyond candles. GET /api/perp/:coin every 60s for the slow
// parts (predicted funding, averages, OI change), and the activeAssetCtx
// websocket feed for mark/oracle/funding/OI in real time. When /api/perp
// fails, the browser's live HL poll (useLiveUniverse) stands in for it.

const POLL_MS = 60_000
const STALE_HOURS = 5 / 60

type Ctx = NonNullable<PerpStats['ctx']>

const num = (s: string | null | undefined) => (s == null || s === '' ? null : Number(s))

/** Folds a websocket asset context over the polled snapshot. */
function mergeLive(base: Ctx | null, live: WsAssetCtx['ctx']): Ctx | null {
  if (!base) return null
  const markPx = num(live.markPx) ?? base.markPx
  const prevDayPx = num(live.prevDayPx) ?? base.prevDayPx
  const oi = num(live.openInterest) ?? base.openInterest
  return {
    ...base,
    markPx,
    oraclePx: num(live.oraclePx) ?? base.oraclePx,
    midPx: num(live.midPx) ?? base.midPx,
    premium: num(live.premium) ?? base.premium,
    funding: num(live.funding) ?? base.funding,
    openInterest: oi,
    openInterestUsd: oi * markPx,
    dayNtlVlm: num(live.dayNtlVlm) ?? base.dayNtlVlm,
    prevDayPx,
    dayChange: prevDayPx > 0 ? markPx / prevDayPx - 1 : base.dayChange,
    impactBidPx: num(live.impactPxs?.[0]) ?? base.impactBidPx,
    impactAskPx: num(live.impactPxs?.[1]) ?? base.impactAskPx,
  }
}

/** The live universe entry for `coin` (exact name first, then case-insensitive). */
function findCtx(u: Pick<UniverseState, 'ctxs'>, coin: string) {
  return u.ctxs.find((c) => c.name === coin) ?? u.ctxs.find((c) => c.name.toUpperCase() === coin.toUpperCase()) ?? null
}

/** /api/perp's shape from the live HL poll alone; null when the coin is not in it. History-backed fields stay null. Pure. */
export function statsFromLive(coin: string, u: Pick<UniverseState, 'ctxs' | 'predicted' | 'atCap' | 'updatedAt'>): PerpStats | null {
  const c = findCtx(u, coin)
  if (!c) return null
  return {
    coin: c.name,
    fetchedAt: new Date(u.updatedAt ?? 0).toISOString(),
    ctx: {
      markPx: c.markPx,
      oraclePx: c.oraclePx,
      midPx: c.midPx,
      premium: c.premium,
      funding: c.funding,
      openInterest: c.openInterest,
      openInterestUsd: c.openInterest * c.markPx,
      dayNtlVlm: c.dayNtlVlm,
      dayBaseVlm: c.dayBaseVlm ?? null,
      prevDayPx: c.prevDayPx,
      dayChange: c.dayChange,
      maxLeverage: c.maxLeverage ?? null,
      impactBidPx: c.impactBidPx ?? null,
      impactAskPx: c.impactAskPx ?? null,
      isDelisted: c.isDelisted,
    },
    atOiCap: u.atCap.includes(c.name),
    predicted: u.predicted.get(c.name) ?? [],
    fundingAvg: { h24: null, d7: null, d30: null },
    oiChange: { h24: null, d7: null },
  }
}

/** Mean hourly funding over the `hours` before `now`; null without a settlement in the window. Pure. */
export function meanFunding(points: FundingPoint[], now: number, hours: number): number | null {
  const from = now - hours * 3_600_000
  const xs = points.filter((p) => p.t > from && p.t <= now).map((p) => p.rate)
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null
}

/** HL vs Binance (else Bybit) funding in one factual sentence, each normalised by its own interval; null without both. Pure. */
export function venueSentence(predicted: PredictedFunding[]): string | null {
  const hl = predicted.find((p) => p.venue === 'HlPerp')
  const cex = predicted.find((p) => p.venue === 'BinPerp') ?? predicted.find((p) => p.venue === 'BybitPerp')
  if (!hl || !cex) return null
  const name = cex.venue === 'BinPerp' ? 'Binance' : 'Bybit'
  // Rounded first, so the gap always equals the two numbers shown.
  const a = Math.round(venueApr(hl) * 100)
  const b = Math.round(venueApr(cex) * 100)
  const gap = a - b
  const pct = (x: number) => `${x > 0 ? '+' : ''}${x}%`
  if (gap === 0) return `HL and ${name} predicted funding match: ${pct(a)} APR.`
  return `HL predicted funding is ${Math.abs(gap)} pts APR ${gap > 0 ? 'above' : 'below'} ${name} (HL ${pct(a)}, ${name} ${pct(b)}).`
}

export function usePerpStats(coin: string) {
  const res = useApi<PerpStats>(coin ? `/perp/${encodeURIComponent(coin)}` : null)
  const universe = useLiveUniverse()
  const [live, setLive] = useState<{ ctx: WsAssetCtx['ctx']; at: number } | null>(null)
  const { refetch } = res

  useEffect(() => {
    const id = setInterval(refetch, POLL_MS)
    return () => clearInterval(id)
  }, [refetch])
  useEffect(() => setLive(null), [coin])

  useHlSubscription<WsAssetCtx>(coin ? { type: 'activeAssetCtx', coin } : null, (d) => {
    if (d.coin === coin) setLive({ ctx: d.ctx, at: Date.now() })
  })

  // /api/perp failed: the live HL poll stands in (no averages or OI change, which need stored history).
  const apiDown = res.data == null && !res.loading && (res.error != null || res.offline)
  const fallback = useMemo(() => (apiDown ? statsFromLive(coin, universe) : null), [apiDown, coin, universe])
  const data = res.data ?? fallback
  const ctx = live && data ? mergeLive(data.ctx, live.ctx) : (data?.ctx ?? null)
  const updatedAt = Math.max(data ? Date.parse(data.fetchedAt) : 0, live?.at ?? 0)
  const loading = res.loading || (apiDown && !fallback && universe.loading)
  const error = fallback ? null : res.error
  return { ...res, data, loading, error, offline: fallback ? false : res.offline, ctx, live: live != null, updatedAt, source: fallback ? ('hl' as const) : ('api' as const) }
}

function countdown(ms: number): string {
  if (ms <= 0) return '00:00'
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = s % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${pad(m)}:${pad(ss)}`
}

const aprStr = (hourly: number | null) => (hourly == null ? '--' : `${fmtPct(fundingApr(hourly), { decimals: 1, sign: true })} APR`)
const bp = (frac: number) => `${(frac * 1e4).toFixed(1)}bp`

/** Title row + stats grid for the drill-in header panel. */
export function PerpHeader({ coin, stats }: { coin: string; stats: ReturnType<typeof usePerpStats> }) {
  const now = useNow(1000)
  const { ctx, data } = stats
  const hlNext = data?.predicted.find((p) => p.venue === 'HlPerp')?.nextFundingTime ?? null
  // HL settles on the hour; without a prediction, the next top of the hour.
  const nextFunding = hlNext != null && hlNext > now ? hlNext : Math.ceil(now / 3_600_000) * 3_600_000
  const spread = ctx?.impactBidPx != null && ctx.impactAskPx != null && ctx.midPx > 0 ? (ctx.impactAskPx - ctx.impactBidPx) / ctx.midPx : null
  // OI 7d needs stored snapshots: hidden until they exist.
  const oi7d = data?.oiChange.d7 ?? null

  return (
    <>
      <div className="flex flex-wrap items-baseline gap-3 px-3 py-3 border-b border-border">
        <span className="text-lg text-text-secondary">{coin}</span>
        {ctx ? (
          <>
            <AnimatedDigits text={fmtPrice(ctx.markPx)} className="text-xl text-text-primary" />
            <span className={`text-md tabular ${classForPnl(ctx.dayChange)}`}>
              {fmtPct(ctx.dayChange, { sign: true })} {ctx.dayChange >= 0 ? '▲' : '▼'}
            </span>
          </>
        ) : (
          <span className="text-base text-text-secondary">--</span>
        )}
        <span className="flex items-center gap-1.5">
          {stats.live && <Badge tone="green">LIVE</Badge>}
          {data?.atOiCap && (
            <span title="Hyperliquid lists this perp at its open-interest cap: new positions can't open, only close">
              <Badge tone="amber">AT OI CAP</Badge>
            </span>
          )}
          {ctx?.isDelisted && <Badge tone="red">DELISTED</Badge>}
          {ctx?.maxLeverage != null && <Badge tone="gray">{ctx.maxLeverage}x MAX</Badge>}
        </span>
        {stats.updatedAt > 0 && !stats.live && <AgeStamp generatedAt={new Date(stats.updatedAt).toISOString()} thresholdHours={STALE_HOURS} />}
      </div>
      <AsyncBody loading={stats.loading} data={ctx} error={data ? null : stats.error} offline={data ? false : stats.offline} rows={2} onRetry={stats.refetch}>
        {(ctx) => (
        <div className={`grid grid-cols-2 sm:grid-cols-4 ${oi7d == null ? 'lg:grid-cols-6' : 'lg:grid-cols-7'} border-b border-border`}>
          <div title="Oracle = Hyperliquid's spot index. Premium = mark vs oracle in basis points; positive = perp above spot">
            <MetricStat label="Oracle" value={fmtPrice(ctx.oraclePx)} delta={`prem ${bp(ctx.premium)}`} deltaPositive={null} />
          </div>
          <MetricStat
            label="Funding 1h"
            value={fmtPct(ctx.funding, { decimals: 4, sign: true })}
            delta={aprStr(ctx.funding)}
            deltaPositive={ctx.funding === 0 ? null : ctx.funding > 0}
          />
          <MetricStat label="Next funding" value={countdown(nextFunding - now)} delta="settles hourly" deltaPositive={null} />
          <MetricStat
            label="Open interest"
            value={fmtUsd(ctx.openInterestUsd, { compact: true })}
            delta={
              data?.oiChange.h24 != null
                ? `${fmtPct(data.oiChange.h24, { sign: true })} 24h`
                : `${ctx.openInterest.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${coin}`
            }
            deltaPositive={data?.oiChange.h24 == null ? null : data.oiChange.h24 > 0}
          />
          {oi7d != null && <MetricStat label="OI 7d" value={fmtPct(oi7d, { sign: true })} deltaPositive={null} />}
          <MetricStat label="24h volume" value={fmtUsd(ctx.dayNtlVlm, { compact: true })} />
          <div title="Impact spread: gap between the prices a standard-size market buy and sell would fill at, over mid. What a market order costs">
            <MetricStat label="Impact spread" value={spread == null ? 'n/a' : bp(spread)} delta="market-order cost" deltaPositive={null} />
          </div>
        </div>
        )}
      </AsyncBody>
    </>
  )
}

const VENUE: Record<string, string> = { HlPerp: 'HYPERLIQUID', BinPerp: 'BINANCE', BybitPerp: 'BYBIT' }

/** Predicted funding across venues + trailing averages. */
export function FundingPanel({ stats }: { stats: ReturnType<typeof usePerpStats> }) {
  const now = useNow(1000)
  const data = stats.data
  // Without stored history (/api/perp down or still syncing), average the last 7 days of HL settlements.
  const needHistory = data != null && (data.fundingAvg.h24 == null || data.fundingAvg.d7 == null)
  const grid = useFundingGrid(needHistory ? [data.coin] : [], 168)
  const points = data ? grid.data.get(data.coin) : undefined
  const avg = {
    h24: data?.fundingAvg.h24 ?? (points ? meanFunding(points, now, 24) : null),
    d7: data?.fundingAvg.d7 ?? (points ? meanFunding(points, now, 168) : null),
    d30: data?.fundingAvg.d30 ?? null,
  }
  const cells = (
    [
      ['Avg 24h', avg.h24],
      ['Avg 7d', avg.d7],
      ['Avg 30d', avg.d30],
    ] as const
  ).filter(([label, v]) => v != null || (label !== 'Avg 30d' && grid.loading) || stats.source === 'api')
  const sentence = data ? venueSentence(data.predicted) : null
  return (
    <>
      <PanelHeader title="FUNDING" />
      <AsyncBody loading={stats.loading} data={data} error={null} rows={3}>
        {(data) => (
        <>
        {sentence && <p className="px-3 py-2 text-base text-text-primary border-b border-border">{sentence}</p>}
        <div className="grid md:grid-cols-2">
          <table className="w-full text-sm tabular">
            <thead>
              <tr className="text-xs text-text-secondary text-left">
                <th className="px-3 py-1.5 font-normal">VENUE</th>
                <th className="px-3 py-1.5 font-normal text-right">PREDICTED</th>
                <th className="px-3 py-1.5 font-normal text-right">APR</th>
                <th className="px-3 py-1.5 font-normal text-right">NEXT</th>
              </tr>
            </thead>
            <tbody>
              {data.predicted.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-3 py-2 text-text-secondary">
                    no cross-venue prediction for this coin
                  </td>
                </tr>
              ) : (
                data.predicted.map((p) => {
                  const apr = (p.rate * 8760) / p.intervalHours
                  return (
                    <tr key={p.venue} className="border-t border-border-subtle">
                      <td className="px-3 py-1.5 text-text-secondary">{VENUE[p.venue] ?? p.venue}</td>
                      <td className={`px-3 py-1.5 text-right ${classForPnl(p.rate)}`}>
                        {fmtPct(p.rate, { decimals: 4, sign: true })}/{p.intervalHours}h
                      </td>
                      <td className={`px-3 py-1.5 text-right ${classForPnl(apr)}`}>{fmtPct(apr, { decimals: 1, sign: true })}</td>
                      <td className="px-3 py-1.5 text-right text-text-secondary">
                        {p.nextFundingTime == null ? '--' : p.nextFundingTime > now ? countdown(p.nextFundingTime - now) : p.venue === 'HlPerp' ? countdown(Math.ceil(now / 3_600_000) * 3_600_000 - now) : 'settling'}
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
          <div className={`grid ${cells.length === 3 ? 'grid-cols-3' : 'grid-cols-2'} border-t md:border-t-0 md:border-l border-border`} title="Mean hourly funding over the window, annualised">
            {cells.map(([label, v]) => (
              <MetricStat
                key={label}
                label={label}
                value={v == null ? '--' : fmtPct(fundingApr(v), { decimals: 1, sign: true })}
                delta={v == null ? (grid.loading ? 'loading' : 'syncing history') : 'APR'}
                deltaPositive={v == null || v === 0 ? null : v > 0}
              />
            ))}
          </div>
        </div>
        </>
        )}
      </AsyncBody>
    </>
  )
}
