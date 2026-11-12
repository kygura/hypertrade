import { useEffect, useState } from 'react'
import { classForPnl, fmtPct, fmtPrice, fmtUsd } from '../../../shared/format'
import { fundingApr, type PerpStats } from '../../../shared/market'
import { useApi } from '../../lib/api'
import { useHlSubscription, type WsAssetCtx } from '../../lib/hlWs'
import { useNow } from '../../lib/hooks'
import { AnimatedDigits } from '../AnimatedDigits'
import { Badge } from '../Badge'
import { HowToRead, type Term } from '../HowToRead'
import { MetricStat } from '../MetricStat'
import { PanelHeader } from '../Panel'
import { AgeStamp, AsyncBody } from '../state'

// Perp context for the markets drill-in: everything Hyperliquid exposes
// about one perp beyond candles. GET /api/perp/:coin every 60s for the slow
// parts (predicted funding, averages, OI change), and the activeAssetCtx
// websocket feed for mark/oracle/funding/OI in real time.

const POLL_MS = 60_000
const STALE_HOURS = 5 / 60

type Ctx = NonNullable<PerpStats['ctx']>

const HEADER_TERMS: readonly Term[] = [
  ['Price · %', 'Mark price, the price Hyperliquid uses for margin and liquidations, and its change against the previous-day price.'],
  ['LIVE', 'Values are streaming over Hyperliquid\'s websocket. Without it they refresh every 60 seconds and an age stamp shows.'],
  ['AT OI CAP', 'Hyperliquid reports this perp at its open interest cap.'],
  ['Nx MAX', 'Highest leverage allowed on this perp.'],
  ['Oracle · premium', 'Oracle is the reference spot price. Premium is how far the perp trades from it, in basis points (1bp = 0.01%). Positive means the perp is above spot.'],
  ['Funding 1h', 'The rate longs pay shorts each hour, as a percent of position size. Negative means shorts pay longs. APR is that rate times the 8,760 hours in a year. The neutral rate is +0.00125% per hour (about 11% a year).'],
  ['Next funding', 'Time to the next hourly settlement.'],
  ['Open interest', 'USD value of all open contracts, with its change over 24 hours from stored snapshots. Before snapshots exist it shows the size in coins.'],
  ['OI 7d', 'Change in open interest over 7 days. "collecting snapshots" means there is not yet a stored reading from 7 days ago.'],
  ['24h volume', 'Notional traded over the last 24 hours, in USD.'],
  ['Impact spread', 'Gap between Hyperliquid\'s impact bid and ask (the prices a standard-size market order would fill at), as basis points of the mid price. Wider means a market order costs more.'],
  ['Mid', 'Midpoint of best bid and ask, with the previous-day price the % change is measured from.'],
]

const FUNDING_TERMS: readonly Term[] = [
  ['PREDICTED', 'The rate each venue is expected to charge at its next settlement, with that venue\'s settlement interval after the slash (1h on Hyperliquid). Positive means longs pay shorts.'],
  ['APR', 'The predicted rate scaled to a year (rate × 8,760 ÷ interval hours), so venues with different intervals compare.'],
  ['NEXT', 'Time to that venue\'s next settlement.'],
  ['Avg 24h · 7d · 30d', 'Mean of Hyperliquid\'s realized hourly funding over each window, annualized. "syncing history" means the funding history for that window is not stored yet.'],
]

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
    const id = setInterval(() => document.visibilityState !== 'hidden' && refetch(), POLL_MS)
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
  const nextFunding = hlNext ?? Math.ceil(now / 3_600_000) * 3_600_000
  const spread = ctx?.impactBidPx != null && ctx.impactAskPx != null && ctx.midPx > 0 ? (ctx.impactAskPx - ctx.impactBidPx) / ctx.midPx : null

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
          {data?.atOiCap && <Badge tone="amber">AT OI CAP</Badge>}
          {ctx?.isDelisted && <Badge tone="red">DELISTED</Badge>}
          {ctx?.maxLeverage != null && <Badge tone="gray">{ctx.maxLeverage}x MAX</Badge>}
        </span>
        {stats.updatedAt > 0 && !stats.live && <AgeStamp generatedAt={new Date(stats.updatedAt).toISOString()} thresholdHours={STALE_HOURS} />}
      </div>
      <AsyncBody loading={stats.loading} data={ctx} error={data ? null : stats.error} rows={2} onRetry={stats.refetch}>
        {(ctx) => (
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 border-b border-border">
          <MetricStat label="Oracle" value={fmtPrice(ctx.oraclePx)} delta={`premium ${bp(ctx.premium)}`} deltaPositive={null} />
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
      </AsyncBody>
      <HowToRead className="px-3 py-2" terms={HEADER_TERMS}>
        Live state of this perp on Hyperliquid. Compare mark with oracle to see how far the perp trades from spot, and funding with open
        interest to see which side is paying to hold and whether positions are building.
      </HowToRead>
    </>
  )
}

const VENUE: Record<string, string> = { HlPerp: 'HYPERLIQUID', BinPerp: 'BINANCE', BybitPerp: 'BYBIT' }

/** Predicted funding across venues + trailing averages. */
export function FundingPanel({ stats }: { stats: ReturnType<typeof usePerpStats> }) {
  const now = useNow(1000)
  const data = stats.data
  const avg = data?.fundingAvg
  return (
    <>
      <PanelHeader title="FUNDING" />
      <HowToRead className="px-3 py-2 border-b border-border-subtle" terms={FUNDING_TERMS}>
        The next funding payment predicted on each venue, and what Hyperliquid has charged on average, all annualized. Look at whether
        venues agree on the sign and how the current rate sits against its own averages.
      </HowToRead>
      <AsyncBody loading={stats.loading} data={data} error={null} rows={3}>
        {(data) => (
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
                    No predicted funding for this coin: Hyperliquid's predicted-funding feed has no entry for it.
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
      </AsyncBody>
    </>
  )
}
