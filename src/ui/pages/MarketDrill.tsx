import { useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { Panel, AnimatedDigits, Button, CandleChart, type Candle, type CandleTf } from '../components'
import { SkeletonRows, ErrorBlock } from '../components/state'
import { useApi } from '../lib/api'
import { fmtPrice, fmtPct, classForPnl, fmtUsd } from '../../shared/format'
import type { MarketRow } from './Markets'

// Markets drill-in — DESIGN.md §10.7. Full view (not an overlay), route
// /markets/:coin — back-button friendly, linkable. Header pulls from the
// same /api/hl/markets snapshot (no dedicated single-coin endpoint exists);
// candles backfill on miss server-side, so a first load can take seconds.

const TF_TO_QUERY: Record<CandleTf, string> = { '1H': '1h', '4H': '4h', '1D': '1d', '1W': '1w' }

interface RawCandle {
  ts: string
  o: number
  h: number
  l: number
  c: number
  v?: number | null
}

export function MarketDrill() {
  const { coin: coinParam } = useParams<{ coin: string }>()
  const coin = (coinParam ?? '').toUpperCase()
  const navigate = useNavigate()
  const [tf, setTf] = useState<CandleTf>('1D')

  const { data: markets } = useApi<MarketRow[]>('/hl/markets')
  const row = markets?.find((r) => r.coin === coin)

  const {
    data: rawCandles,
    loading,
    error,
    refetch,
  } = useApi<RawCandle[]>(coin ? `/candles/${coin}?tf=${TF_TO_QUERY[tf]}` : null)

  const candles = useMemo<Candle[]>(
    () => (rawCandles ?? []).map((c) => ({ ts: new Date(c.ts).getTime(), o: c.o, h: c.h, l: c.l, c: c.c, v: c.v ?? 0 })),
    [rawCandles],
  )

  return (
    <div className="max-w-[1440px] mx-auto p-3 md:p-[var(--gutter)] flex flex-col gap-3">
      <Button tier="ghost" onClick={() => navigate('/markets')} className="self-start">
        ← MARKETS
      </Button>

      <Panel>
        <div className="flex flex-wrap items-baseline gap-3 px-3 py-3 border-b border-border">
          <span className="text-[16px] uppercase text-text-secondary">{coin}</span>
          {row ? (
            <>
              <AnimatedDigits text={fmtPrice(row.markPx)} className="text-[22px] text-text-primary" />
              <span className={`text-[12px] tabular ${classForPnl(row.dayChangePct)}`}>
                {fmtPct(row.dayChangePct, { sign: true })} {row.dayChangePct >= 0 ? '▲' : '▼'}
              </span>
            </>
          ) : (
            <span className="text-[13px] text-text-secondary">--</span>
          )}
        </div>
        {row && (
          <div className="px-3 py-2 text-[11px] text-text-secondary tabular">
            OI {fmtUsd(row.openInterestUsd, { compact: true })} · FUND {fmtPct(row.funding, { decimals: 4, sign: true })} · VOL{' '}
            {fmtUsd(row.dayNtlVlm, { compact: true })}
          </div>
        )}
      </Panel>

      <Panel>
        {error && candles.length === 0 ? (
          <ErrorBlock message={error} onRetry={refetch} />
        ) : loading && candles.length === 0 ? (
          <div className="flex flex-col gap-2">
            <SkeletonRows />
            <span className="text-[10px] text-text-secondary text-center pulse-label">backfilling candles…</span>
          </div>
        ) : (
          <CandleChart candles={candles} tf={tf} onTfChange={setTf} />
        )}
      </Panel>
    </div>
  )
}
