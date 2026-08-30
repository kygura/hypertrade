import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { Panel, PanelHeader, PanelBody, SrcTag, DataTable, type Column } from '../components'
import { SkeletonRows, EmptyBlock, ErrorBlock, StaleBanner } from '../components/state'
import { useApi } from '../lib/api'
import { fmtPrice, fmtPct, classForPnl, fmtUsd } from '../../shared/format'

// Markets — DESIGN.md §10.7. HL universe table, live-ish (poll every 15s),
// tick flash on price change, funding crowded-trade flag, filter + sort.

const POLL_MS = 15_000
const STALE_MIN = 5

export interface MarketRow {
  coin: string
  markPx: number
  oraclePx: number
  premium: number
  funding: number
  openInterestUsd: number
  dayNtlVlm: number
  dayChangePct: number
}

const FUNDING_CROWDED = 0.001 // |funding| >= 0.1%/8h

export function Markets() {
  const navigate = useNavigate()
  const { data, loading, error, refetch } = useApi<MarketRow[]>('/hl/markets')
  const [filter, setFilter] = useState('')
  const [lastFetchedAt, setLastFetchedAt] = useState<number | null>(null)

  const prevPx = useRef<Map<string, number>>(new Map())
  const [flash, setFlash] = useState<Map<string, 'up' | 'down'>>(new Map())

  useEffect(() => {
    const id = setInterval(refetch, POLL_MS)
    return () => clearInterval(id)
  }, [refetch])

  useEffect(() => {
    if (!data) return
    setLastFetchedAt(Date.now())
    const next = new Map<string, 'up' | 'down'>()
    for (const row of data) {
      const prev = prevPx.current.get(row.coin)
      if (prev != null && prev !== row.markPx) next.set(row.coin, row.markPx > prev ? 'up' : 'down')
      prevPx.current.set(row.coin, row.markPx)
    }
    if (next.size > 0) {
      setFlash(next)
      const t = setTimeout(() => setFlash(new Map()), 220)
      return () => clearTimeout(t)
    }
  }, [data])

  const filtered = useMemo(() => {
    const q = filter.trim().toUpperCase()
    if (!q) return data ?? []
    return (data ?? []).filter((r) => r.coin.includes(q))
  }, [data, filter])

  const columns: Column<MarketRow>[] = [
    { key: 'coin', label: 'COIN', priority: 1, sortValue: (r) => r.coin, render: (r) => r.coin },
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
      label: 'FUNDING',
      priority: 4,
      align: 'right',
      sortValue: (r) => r.funding,
      render: (r) => (
        <span className={Math.abs(r.funding) >= FUNDING_CROWDED ? 'text-amber' : classForPnl(r.funding)}>
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
  ]

  return (
    <div className="max-w-[1440px] mx-auto p-3 md:p-[var(--gutter)]">
      <Panel>
        <PanelHeader title="MARKETS">
          <SrcTag source="hl" />
          <span className="text-[10px] text-text-secondary tabular">{data ? `${filtered.length} PERPS` : ''}</span>
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="FILTER"
            className="!h-[var(--control-sm)] !py-0 !px-2 !text-[10px] w-24 md:w-40 uppercase placeholder:text-text-secondary"
          />
        </PanelHeader>
        <PanelBody>
          {lastFetchedAt && (
            <StaleBanner generatedAt={new Date(lastFetchedAt).toISOString()} thresholdHours={STALE_MIN / 60} noun="snapshot" />
          )}
          {loading && !data ? (
            <SkeletonRows rows={5} />
          ) : error ? (
            <ErrorBlock message={error} onRetry={refetch} />
          ) : filtered.length === 0 ? (
            <EmptyBlock label={filter ? 'no coins match' : 'no markets yet'} />
          ) : (
            <DataTable
              columns={columns}
              rows={filtered}
              rowKey={(r) => r.coin}
              onRowClick={(r) => navigate(`/markets/${r.coin}`)}
              sortable
              defaultSort={{ key: 'oi', dir: 'desc' }}
            />
          )}
        </PanelBody>
      </Panel>
    </div>
  )
}
