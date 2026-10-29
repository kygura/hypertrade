import { useState } from 'react'
import { Navigate, useNavigate, useParams } from 'react-router'
import { Segmented } from '../components/Segmented'
import { Panel, PanelHeader, PanelBody } from '../components/Panel'
import { ErrorBlock, OfflineBlock, SkeletonRows } from '../components/state'
import { useApi } from '../lib/api'
import { CycleChart } from '../components/cycles/CycleChart'
import { AnalogChart } from '../components/cycles/AnalogChart'
import { CoolingHighsTable, EpisodesTable, ForecastHero, MethodsTable, ReadinessStrip } from '../components/cycles/ForecastPanel'
import { fmtDay } from '../components/cycles/format'
import { CYCLE_COINS, type CycleCoin, type CyclesResponse } from '../../shared/cycles'
import type { OnsetKind } from '../../shared/cycleForecast'

// /cycles, /cycles/eth — the hl-cycles cycle view (phase-banded log chart,
// SMA200, halvings) for BTC or ETH, with a next-bull-run estimate layered on: headline window and
// readiness strip, the chart with the projected window, cycle analogs from
// the top, the four timing methods, and the past runs they're built on.
// RUN START picks how a run is dated: its breakout (the final doubling into
// euphoria, Oct 2016/2020/2023) or its first euphoric day.

const KIND_OPTIONS = [
  { value: 'breakout' as const, label: 'BREAKOUT', title: 'Date runs from the start of the final doubling into euphoria (Oct 2016, Oct 2020, Oct 2023)' },
  { value: 'euphoria' as const, label: 'EUPHORIA', title: 'Date runs from the first day the model commits to euphoria (Mar 2017, Dec 2020, Mar 2024)' },
]

const COIN_OPTIONS = CYCLE_COINS.map((c) => ({ value: c, label: c }))
/** First year of each coin's history, for the loading line. */
const SINCE: Record<CycleCoin, number> = { BTC: 2011, ETH: 2015 }

export function Cycles() {
  const param = useParams().coin
  const navigate = useNavigate()
  const coin = (param ?? 'btc').toUpperCase() as CycleCoin
  const [tf, setTf] = useState<'1d' | '1w'>('1d')
  const [kind, setKind] = useState<OnsetKind>('breakout')
  const valid = (CYCLE_COINS as readonly string[]).includes(coin)
  // useApi keeps the previous body while a coin or timeframe switch loads.
  const { data: body, loading, error, offline, refetch } = useApi<CyclesResponse>(valid ? `/cycles?coin=${coin}&tf=${tf}` : null)
  // BTC lives at /cycles; an unknown coin goes there too.
  if (!valid || param === 'btc') return <Navigate to="/cycles" replace />
  const coinSwitch = (
    <Segmented label="Coin" options={COIN_OPTIONS} value={coin} onChange={(c) => navigate(c === 'BTC' ? '/cycles' : `/cycles/${c.toLowerCase()}`)} />
  )

  if (!body) {
    return (
      <div className="max-w-[1440px] mx-auto p-3 md:p-[var(--gutter)] flex flex-col gap-3">
        <div>{coinSwitch}</div>
        {loading && (
          <div className="flex flex-col gap-2">
            <SkeletonRows />
            <span className="text-xs text-text-secondary text-center pulse-label">loading {coin} history since {SINCE[coin]}…</span>
          </div>
        )}
        {!loading && offline && <OfflineBlock onRetry={refetch} />}
        {!loading && !offline && error && <ErrorBlock message={error} onRetry={refetch} />}
      </div>
    )
  }

  // Until a switch lands, the body on screen is the previous coin's.
  const shownCoin = body.coin
  const forecast = body.forecasts[kind]
  const other = body.forecasts[kind === 'breakout' ? 'euphoria' : 'breakout']
  const r = forecast.readiness
  const shallower = r?.lowDepth != null && r.priorBearDepths.length > 0 && r.lowDepth > Math.max(...r.priorBearDepths)
  const sources = Object.entries(body.sources)
    .map(([k, n]) => `${k} ${n.toLocaleString('en-US')}d`)
    .join(' · ')

  return (
    <div className="max-w-[1440px] mx-auto p-3 md:p-[var(--gutter)] flex flex-col gap-3 lg:grid lg:grid-cols-12">
      <Panel className="lg:col-span-12">
        <PanelHeader title={`NEXT ${shownCoin} BULL RUN · ESTIMATE`}>
          <span className={`hidden md:inline text-xs text-text-secondary tabular ${loading ? 'pulse-label' : ''}`}>as of {fmtDay(body.asOf)}</span>
          {coinSwitch}
          <Segmented label="Run start" options={KIND_OPTIONS} value={kind} onChange={setKind} />
        </PanelHeader>
        <PanelBody className="p-0">
          <ForecastHero forecast={forecast} other={other} />
          <ReadinessStrip forecast={forecast} />
        </PanelBody>
      </Panel>

      <Panel className="lg:col-span-12">
        <PanelHeader title={`CYCLE · ${shownCoin}/USD · LOG`} />
        <PanelBody className="p-0">
          <CycleChart
            bars={body.bars}
            coin={shownCoin}
            halvings={body.halvings}
            nextHalving={body.nextHalving}
            forecast={forecast}
            coolingHighs={body.coolingHighs}
            tf={tf}
            onTfChange={setTf}
          />
        </PanelBody>
      </Panel>

      <Panel className="lg:col-span-6">
        <PanelHeader title="CYCLES FROM THE TOP" />
        <PanelBody className="p-0">
          <AnalogChart analogs={body.analogs} forecast={forecast} />
        </PanelBody>
      </Panel>

      <Panel className="lg:col-span-6">
        <PanelHeader title="TIMING METHODS" />
        <PanelBody className="p-0">
          <MethodsTable forecast={forecast} coin={shownCoin} />
        </PanelBody>
      </Panel>

      <Panel className="lg:col-span-12">
        <PanelHeader title="HIGHER HIGHS ON LOWER HEAT" />
        <PanelBody className="p-0">
          <p className="px-3 pt-2 pb-1 text-sm text-text-secondary">
            All-time-high legs (split by 20% pullbacks) whose peak printed on at least 0.05 less heat than the leg before, within one cycle. In past
            cycles these came late in the run: price still rising while the stretch behind it faded. A reading of what happened, not a signal.
          </p>
          <CoolingHighsTable highs={body.coolingHighs} />
        </PanelBody>
      </Panel>

      <Panel className="lg:col-span-12">
        <PanelHeader title="PAST BULL RUNS" />
        <PanelBody className="p-0">
          <EpisodesTable episodes={forecast.episodes} kind={kind} />
          <p className="px-3 py-2 text-sm text-text-secondary border-t border-border-subtle">
            {forecast.episodes.length} runs is a small sample and the spread between methods is the honest error bar.
            {shallower && ' This bear market has bottomed shallower than every past one so far; a lower low would move the bear-low anchor, and the estimate with it, later.'}{' '}
            Halving dates are BTC's{shownCoin !== 'BTC' && `, used as the market's clock for ${shownCoin}`}; the next one is a block-time estimate.
            {body.sources.coinmetrics ? ' Coin Metrics days are daily reference closes, so they draw as flat bars.' : ''} History: {sources}.
          </p>
        </PanelBody>
      </Panel>
    </div>
  )
}
