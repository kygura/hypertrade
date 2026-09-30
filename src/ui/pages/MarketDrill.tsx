import { useNavigate, useParams, useSearchParams } from 'react-router'
import { Button, Panel } from '../components'
import { MarketChart } from '../components/charts/MarketChart'
import { FundingPanel, PerpHeader, usePerpStats } from '../components/market/PerpPanels'
import { isTimeframe, type Timeframe } from '../../shared/timeframes'

// Markets drill-in — DESIGN.md §10.7. Full view (not an overlay), route
// /markets/:coin?tf=4h — back-button friendly, linkable. Header: live perp
// context (mark/oracle/funding/OI over HL's websocket). Chart: every
// timeframe from 1m to 1M with funding, OI and premium panes; history pages
// in as you scroll left and the server backfills it on demand.

const DEFAULT_TF: Timeframe = '1d'

export function MarketDrill() {
  // HL coin names are case-sensitive ("kPEPE"); the param is passed as-is and
  // the server resolves it against the live universe.
  const { coin = '' } = useParams<{ coin: string }>()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const tfParam = params.get('tf')
  const tf: Timeframe = isTimeframe(tfParam) ? tfParam : DEFAULT_TF
  const stats = usePerpStats(coin)
  const name = stats.data?.coin ?? coin

  const setTf = (next: Timeframe) => {
    const p = new URLSearchParams(params)
    if (next === DEFAULT_TF) p.delete('tf')
    else p.set('tf', next)
    setParams(p, { replace: true })
  }

  return (
    <div className="max-w-[1440px] mx-auto p-3 md:p-[var(--gutter)] flex flex-col gap-3">
      <Button tier="ghost" onClick={() => navigate('/markets')} className="self-start">
        ← MARKETS
      </Button>

      <Panel>
        <PerpHeader coin={name} stats={stats} />
      </Panel>

      <Panel>
        <MarketChart key={name} coin={name} tf={tf} onTfChange={setTf} />
      </Panel>

      <Panel>
        <FundingPanel stats={stats} />
      </Panel>
    </div>
  )
}
