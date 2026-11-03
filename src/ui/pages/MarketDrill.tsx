import { useMemo } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router'
import { Button, Panel } from '../components'
import { useQueryPatch } from '../lib/hooks'
import { useLiveUniverse } from '../lib/hlLive'
import { MarketChart } from '../components/charts/MarketChart'
import { FundingPanel, PerpHeader, usePerpStats } from '../components/market/PerpPanels'
import { SignalList } from '../components/market-read'
import { coinRead } from '../../shared/marketRead'
import { deriveSignals } from '../../shared/signals'
import { isTimeframe, type Timeframe } from '../../shared/timeframes'
import type { AssetCtx } from '../../shared/types'

// Markets drill-in — docs/design/README.md §10.7. Full view (not an overlay), route
// /markets/:coin?tf=4h — back-button friendly, linkable. Header: live perp
// context (mark/oracle/funding/OI over HL's websocket) and a one-line read.
// This coin's signal card, if any, sits above the chart. Chart: every
// timeframe from 1m to 1M with funding, OI and premium panes; history pages
// in as you scroll left and the server backfills it on demand.

const DEFAULT_TF: Timeframe = '1d'

export function MarketDrill() {
  // HL coin names are case-sensitive ("kPEPE"); the param is passed as-is and
  // the server resolves it against the live universe.
  const { coin = '' } = useParams<{ coin: string }>()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const patch = useQueryPatch()
  const tfParam = params.get('tf')
  const tf: Timeframe = isTimeframe(tfParam) ? tfParam : DEFAULT_TF
  const stats = usePerpStats(coin)
  const universe = useLiveUniverse()
  const name = stats.data?.coin ?? coin

  const read = useMemo(() => {
    const c = stats.ctx
    if (!c) return null
    const ctx: AssetCtx = { ...c, name, szDecimals: 0, maxLeverage: c.maxLeverage ?? undefined, dayBaseVlm: c.dayBaseVlm ?? undefined }
    const ranked = [...universe.ctxs].filter((x) => !x.isDelisted).sort((a, b) => b.openInterest * b.markPx - a.openInterest * a.markPx)
    const i = ranked.findIndex((x) => x.name === name)
    const predicted = stats.data?.predicted.length ? stats.data.predicted : universe.predicted.get(name)
    return coinRead({ ctx, rank: i >= 0 ? i + 1 : null, predicted, atCap: stats.data?.atOiCap ?? universe.atCap.includes(name) })
  }, [stats.ctx, stats.data, universe, name])

  const signals = useMemo(
    () => deriveSignals({ ctxs: universe.ctxs, predicted: universe.predicted, atCap: universe.atCap }, Infinity).filter((s) => s.coin === name),
    [universe, name],
  )

  const setTf = (next: Timeframe) => patch({ tf: next === DEFAULT_TF ? null : next })

  return (
    <div className="max-w-[1440px] mx-auto p-3 md:p-[var(--gutter)] flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <Button tier="ghost" onClick={() => navigate('/')}>
          ← MARKET
        </Button>
      </div>

      <Panel>
        <PerpHeader coin={name} stats={stats} />
        {read && <p className="px-3 py-2 text-md text-text-secondary tabular">{read}</p>}
      </Panel>

      {signals.length > 0 && <SignalList signals={signals} link={false} />}

      <Panel>
        <MarketChart key={name} coin={name} tf={tf} onTfChange={setTf} />
      </Panel>

      <Panel>
        <FundingPanel stats={stats} />
      </Panel>
    </div>
  )
}
