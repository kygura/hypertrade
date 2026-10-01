import { useEffect, useState } from 'react'
import { classForPnl, fmtPct, fmtPrice, fmtUsd } from '../../../shared/format'
import { fundingApr, type PerpStats } from '../../../shared/market'
import { useApi } from '../../lib/api'
import { useHlSubscription, type WsAssetCtx } from '../../lib/hlWs'
import { AnimatedDigits } from '../AnimatedDigits'
import { Badge } from '../Badge'
import { MetricStat } from '../MetricStat'
import { PanelHeader } from '../Panel'
import { AgeStamp, ErrorBlock, SkeletonRows } from '../state'

// Perp context for the markets drill-in: everything Hyperliquid exposes
// about one perp beyond candles. GET /api/perp/:coin every 60s for the slow
// parts (predicted funding, averages, OI change), and the activeAssetCtx
// websocket feed for mark/oracle/funding/OI in real time.

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

export function usePerpStats(coin: string) {
  const res = useApi<PerpStats>(coin ? `/perp/${encodeURIComponent(coin)}` : null)
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

  const ctx = live && res.data ? mergeLive(res.data.ctx, live.ctx) : (res.data?.ctx ?? null)
  const updatedAt = Math.max(res.data ? Date.parse(res.data.fetchedAt) : 0, live?.at ?? 0)
  return { ...res, ctx, live: live != null, updatedAt }
}

function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(id)
  }, [ms])
  return now
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
  const now = useNow()
  const { ctx, data } = stats
  const hlNext = data?.predicted.find((p) => p.venue === 'HlPerp')?.nextFundingTime ?? null
  // HL settles on the hour; without a prediction, the next top of the hour.
  const nextFunding = hlNext ?? Math.ceil(now / 3_600_000) * 3_600_000
  const spread = ctx?.impactBidPx != null && ctx.impactAskPx != null && ctx.midPx > 0 ? (ctx.impactAskPx - ctx.impactBidPx) / ctx.midPx : null

  return (
    <>
      <div className="flex flex-wrap items-baseline gap-3 px-3 py-3 border-b border-border">
        <span className="text-[16px] text-text-secondary">{coin}</span>
        {ctx ? (
          <>
            <AnimatedDigits text={fmtPrice(ctx.markPx)} className="text-[22px] text-text-primary" />
            <span className={`text-[12px] tabular ${classForPnl(ctx.dayChange)}`}>
              {fmtPct(ctx.dayChange, { sign: true })} {ctx.dayChange >= 0 ? '▲' : '▼'}
            </span>
          </>
        ) : (
          <span className="text-[13px] text-text-secondary">--</span>
        )}
        <span className="flex items-center gap-1.5">
          {stats.live && <Badge tone="green">LIVE</Badge>}
          {data?.atOiCap && <Badge tone="amber">AT OI CAP</Badge>}
          {ctx?.isDelisted && <Badge tone="red">DELISTED</Badge>}
          {ctx?.maxLeverage != null && <Badge tone="gray">{ctx.maxLeverage}x MAX</Badge>}
        </span>
        {stats.updatedAt > 0 && !stats.live && <AgeStamp generatedAt={new Date(stats.updatedAt).toISOString()} thresholdHours={STALE_HOURS} />}
      </div>
      {stats.error && !data ? (
        <ErrorBlock message={stats.error} onRetry={stats.refetch} />
      ) : !ctx ? (
        stats.loading ? <SkeletonRows rows={2} /> : null
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 border-b border-border">
          <MetricStat label="Oracle" value={fmtPrice(ctx.oraclePx)} delta={`prem ${bp(ctx.premium)}`} deltaPositive={null} />
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
          <MetricStat
            label="OI 7d"
            value={data?.oiChange.d7 != null ? fmtPct(data.oiChange.d7, { sign: true }) : '--'}
            delta={data?.oiChange.d7 == null ? 'collecting snapshots' : null}
            deltaPositive={null}
          />
          <MetricStat label="24h volume" value={fmtUsd(ctx.dayNtlVlm, { compact: true })} />
          <MetricStat label="Impact spread" value={spread == null ? '--' : bp(spread)} delta="market-order cost" deltaPositive={null} />
          <MetricStat label="Mid" value={fmtPrice(ctx.midPx)} delta={`prev day ${fmtPrice(ctx.prevDayPx)}`} deltaPositive={null} />
        </div>
      )}
    </>
  )
}

const VENUE: Record<string, string> = { HlPerp: 'HYPERLIQUID', BinPerp: 'BINANCE', BybitPerp: 'BYBIT' }

/** Predicted funding across venues + trailing averages. */
export function FundingPanel({ stats }: { stats: ReturnType<typeof usePerpStats> }) {
  const now = useNow()
  const data = stats.data
  const avg = data?.fundingAvg
  return (
    <>
      <PanelHeader title="FUNDING" />
      {!data ? (
        stats.loading ? <SkeletonRows rows={3} /> : null
      ) : (
        <div className="grid md:grid-cols-2">
          <table className="w-full text-[11px] tabular">
            <thead>
              <tr className="text-[10px] text-text-secondary text-left">
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
                        {p.nextFundingTime == null ? '--' : countdown(p.nextFundingTime - now)}
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
          <div className="grid grid-cols-3 border-t md:border-t-0 md:border-l border-border">
            {(
              [
                ['Avg 24h', avg?.h24 ?? null],
                ['Avg 7d', avg?.d7 ?? null],
                ['Avg 30d', avg?.d30 ?? null],
              ] as const
            ).map(([label, v]) => (
              <MetricStat
                key={label}
                label={label}
                value={v == null ? '--' : fmtPct(fundingApr(v), { decimals: 1, sign: true })}
                delta={v == null ? 'syncing history' : 'APR'}
                deltaPositive={v == null || v === 0 ? null : v > 0}
              />
            ))}
          </div>
        </div>
      )}
    </>
  )
}
