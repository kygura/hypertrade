import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { Panel, PanelHeader, PanelBody, SrcTag, DataTable, Segmented, HowToRead, type Column, type Term } from '../components'
import { AsyncBody, StaleBanner } from '../components/state'
import { useApi } from '../lib/api'
import type { MarketRow, MarketsResponse } from '../../server/routes/hl'
import { fmtPrice, fmtPct, classForPnl, fmtUsd } from '../../shared/format'
import { ASSET_CLASSES, tickerOf, type AssetClass } from '../../shared/assetClass'
import { median } from '../../shared/signalMath'

// Markets — docs/design/README.md §10.7. HL universe table, live-ish (poll every 15s),
// tick flash on price change, funding crowded-trade flag, filter + sort. Covers
// the main dex and every HIP-3 builder dex (GET /hl/markets?scope=all), split by
// asset class.

const POLL_MS = 15_000
const STALE_MIN = 5

// HL funding is an hourly fraction (settles hourly; see "Funding 1h" in PerpPanels and fundingApr
// in shared/signalMath). Crowded = |funding| >= 0.1% per 8h, i.e. 0.0125% per hour (~110% APR).
export const FUNDING_CROWDED = 0.001 / 8
export const isFundingCrowded = (hourly: number): boolean => Math.abs(hourly) >= FUNDING_CROWDED

/**
 * The one fact line above the table, over the rows on screen: how many perps rose and fell over 24h with the
 * median change, how many sit at or past the crowded-funding threshold on each side, and the largest open
 * interest with its share of the total. Null with no rows.
 */
export function marketsInsight(rows: Pick<MarketRow, 'coin' | 'dayChangePct' | 'funding' | 'openInterestUsd'>[]): string | null {
  if (rows.length === 0) return null
  const up = rows.filter((r) => r.dayChangePct > 0).length
  const down = rows.filter((r) => r.dayChangePct < 0).length
  const hot = rows.filter((r) => r.funding >= FUNDING_CROWDED).length
  const cold = rows.filter((r) => r.funding <= -FUNDING_CROWDED).length
  const totalOi = rows.reduce((a, r) => a + r.openInterestUsd, 0)
  const top = rows.reduce((a, r) => (r.openInterestUsd > a.openInterestUsd ? r : a))
  const parts = [
    `${rows.length} ${rows.length === 1 ? 'perp' : 'perps'}: ${up} up and ${down} down over 24h, median ${fmtPct(median(rows.map((r) => r.dayChangePct)), { sign: true })}`,
    `funding at or above +0.0125% per hour on ${hot}, at or below −0.0125% on ${cold}`,
  ]
  if (totalOi > 0) parts.push(`${tickerOf(top.coin)} holds ${fmtPct(top.openInterestUsd / totalOi, { decimals: 0 })} of the ${fmtUsd(totalOi, { compact: true })} open interest`)
  return parts.join('; ') + '.'
}

type ClassFilter = 'all' | AssetClass
const CLASS_LABEL: Record<AssetClass, string> = {
  crypto: 'CRYPTO',
  equity: 'STOCKS',
  commodity: 'COMMODITIES',
  index: 'INDEX',
  fx: 'FX',
  rates: 'RATES',
}
/** Phone label where the full word does not fit. */
const CLASS_SHORT: Partial<Record<AssetClass, string>> = { commodity: 'CMDTY' }

const TERMS: readonly Term[] = [
  ['COIN · DEX', 'The perp and where it trades. HL is the main Hyperliquid dex; any other name is a builder-deployed dex (HIP-3).'],
  ['PRICE', 'Mark price in USD, the price Hyperliquid uses for margin and liquidations. It flashes when it changes between refreshes.'],
  ['24H%', 'Mark price against Hyperliquid\'s previous-day price, about 24 hours ago.'],
  ['OI', 'Open interest in USD: all open contracts times the mark price. It counts positions held, not volume traded.'],
  ['FUNDING 1H', 'The rate longs pay shorts each hour, as a percent of position size. Negative means shorts pay longs. The neutral rate on Hyperliquid is +0.00125% per hour. Amber from 0.0125% per hour in either direction (0.1% per 8 hours, about 110% a year): one side is paying heavily to hold.'],
  ['VOLUME', 'Notional traded over the last 24 hours, in USD.'],
  ['MAX LEV', 'Highest leverage Hyperliquid allows on this perp.'],
  ['Asset class tabs', 'Filter by what the perp tracks; the number is the count of perps in that class.'],
]

export function Markets() {
  const navigate = useNavigate()
  const { data, loading, error, offline, refetch } = useApi<MarketsResponse>('/hl/markets?scope=all')
  const markets = data?.markets ?? null
  const [filter, setFilter] = useState('')
  const [cls, setCls] = useState<ClassFilter>('all')

  const prevPx = useRef<Map<string, number>>(new Map())
  const [flash, setFlash] = useState<Map<string, 'up' | 'down'>>(new Map())

  useEffect(() => {
    const id = setInterval(() => document.visibilityState !== 'hidden' && refetch(), POLL_MS)
    return () => clearInterval(id)
  }, [refetch])

  useEffect(() => {
    if (!markets) return
    const next = new Map<string, 'up' | 'down'>()
    for (const row of markets) {
      const prev = prevPx.current.get(row.coin)
      if (prev != null && prev !== row.markPx) next.set(row.coin, row.markPx > prev ? 'up' : 'down')
      prevPx.current.set(row.coin, row.markPx)
    }
    if (next.size > 0) {
      setFlash(next)
      const t = setTimeout(() => setFlash(new Map()), 220)
      return () => clearTimeout(t)
    }
  }, [markets])

  const counts = useMemo(() => {
    const m = new Map<ClassFilter, number>([['all', markets?.length ?? 0]])
    for (const r of markets ?? []) m.set(r.assetClass, (m.get(r.assetClass) ?? 0) + 1)
    return m
  }, [markets])

  const filtered = useMemo(() => {
    const q = filter.trim().toUpperCase()
    return (markets ?? []).filter((r) => (cls === 'all' || r.assetClass === cls) && (!q || r.coin.toUpperCase().includes(q)))
  }, [markets, filter, cls])

  const classOptions = [
    { value: 'all' as ClassFilter, label: `ALL ${counts.get('all') ?? 0}`, short: 'ALL' },
    ...ASSET_CLASSES.filter((c) => counts.has(c)).map((c) => ({
      value: c as ClassFilter,
      label: `${CLASS_LABEL[c]} ${counts.get(c)}`,
      short: CLASS_SHORT[c] ?? CLASS_LABEL[c],
    })),
  ]

  const columns: Column<MarketRow>[] = [
    { key: 'coin', label: 'COIN', priority: 1, sortValue: (r) => tickerOf(r.coin), render: (r) => tickerOf(r.coin) },
    {
      key: 'dex',
      label: 'DEX',
      priority: 3,
      sortValue: (r) => r.dex,
      render: (r) => <span className="text-text-secondary">{r.dex ? r.dex.toUpperCase() : 'HL'}</span>,
    },
    {
      key: 'price',
      label: 'PRICE',
      priority: 1,
      align: 'right',
      sortValue: (r) => r.markPx,
      render: (r) => (
        <span className={flash.get(r.coin) === 'up' ? 'flash-up' : flash.get(r.coin) === 'down' ? 'flash-down' : ''}>
          {fmtPrice(r.markPx)}
        </span>
      ),
    },
    {
      key: 'chg',
      label: '24H%',
      priority: 2,
      align: 'right',
      sortValue: (r) => r.dayChangePct,
      render: (r) => (
        <span className={classForPnl(r.dayChangePct)}>
          {fmtPct(r.dayChangePct, { sign: true })} {r.dayChangePct >= 0 ? '▲' : '▼'}
        </span>
      ),
    },
    {
      key: 'oi',
      label: 'OI',
      priority: 3,
      align: 'right',
      sortValue: (r) => r.openInterestUsd,
      render: (r) => fmtUsd(r.openInterestUsd, { compact: true }),
    },
    {
      key: 'funding',
      label: 'FUNDING 1H',
      priority: 4,
      align: 'right',
      sortValue: (r) => r.funding,
      render: (r) => (
        <span className={isFundingCrowded(r.funding) ? 'text-amber' : classForPnl(r.funding)}>
          {fmtPct(r.funding, { decimals: 4, sign: true })}
        </span>
      ),
    },
    {
      key: 'vol',
      label: 'VOLUME',
      priority: 4,
      align: 'right',
      sortValue: (r) => r.dayNtlVlm,
      render: (r) => fmtUsd(r.dayNtlVlm, { compact: true }),
    },
    {
      key: 'lev',
      label: 'MAX LEV',
      priority: 4,
      align: 'right',
      sortValue: (r) => r.maxLeverage ?? 0,
      render: (r) => (r.maxLeverage == null ? '—' : `${r.maxLeverage}x`),
    },
  ]

  return (
    <div className="max-w-[1440px] mx-auto p-3 md:p-[var(--gutter)]">
      <Panel>
        <PanelHeader title="MARKETS">
          <SrcTag source="hl" />
          <span className="text-xs text-text-secondary tabular">{markets ? `${filtered.length} PERPS` : ''}</span>
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="FILTER"
            className="!h-[var(--control-sm)] !py-0 !px-2 !text-xs w-24 md:w-40 uppercase placeholder:text-text-secondary"
          />
        </PanelHeader>
        <div className="px-3 pt-2 overflow-x-auto">
          <Segmented options={classOptions} value={cls} onChange={setCls} label="Asset class" />
        </div>
        <PanelBody>
          {filtered.length > 0 && <p className="text-md text-text-primary mb-1 max-w-[110ch]">{marketsInsight(filtered)}</p>}
          <HowToRead className="mb-2" terms={TERMS}>
            Every perp on Hyperliquid, refreshed every 15 seconds. Sort a column to see where open interest, volume or funding is
            concentrated, then click a row for its chart.
          </HowToRead>
          {data?.failedDexes && data.failedDexes.length > 0 && (
            <p className="text-2xs text-amber mb-2">
              {data.failedDexes.map((d) => d.toUpperCase()).join(', ')} missing from this table: Hyperliquid did not return that dex's snapshot this refresh.
            </p>
          )}
          {data && <StaleBanner generatedAt={data.fetchedAt} thresholdHours={STALE_MIN / 60} noun="snapshot" />}
          <AsyncBody
            loading={loading}
            data={data}
            error={error}
            offline={offline}
            rows={5}
            empty={{
              label: filter
                ? `No perp matches "${filter.trim().toUpperCase()}"${cls === 'all' ? '' : ` in ${CLASS_LABEL[cls]}`}. Clear the filter to see the full list.`
                : 'No markets loaded. This table lists the live Hyperliquid universe, and the last snapshot came back empty.',
            }}
            isEmpty={() => filtered.length === 0}
            onRetry={refetch}
          >
            {() => (
              <DataTable
                columns={columns}
                rows={filtered}
                rowKey={(r) => r.coin}
                onRowClick={(r) => navigate(`/markets/${encodeURIComponent(r.coin)}`)}
                sortable
                defaultSort={{ key: 'oi', dir: 'desc' }}
              />
            )}
          </AsyncBody>
        </PanelBody>
      </Panel>
    </div>
  )
}
