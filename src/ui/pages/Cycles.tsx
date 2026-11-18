import { useState } from 'react'
import { Navigate, useNavigate, useParams } from 'react-router'
import { HowToRead, type Term } from '../components/HowToRead'
import { Segmented } from '../components/Segmented'
import { Panel, PanelHeader, PanelBody } from '../components/Panel'
import { ErrorBlock, OfflineBlock, SkeletonRows } from '../components/state'
import { useApi } from '../lib/api'
import { CycleChart } from '../components/cycles/CycleChart'
import { AnalogChart } from '../components/cycles/AnalogChart'
import { CoolingHighsTable, EpisodesTable, ForecastHero, MethodsTable, ReadinessStrip } from '../components/cycles/ForecastPanel'
import { fmtDay } from '../components/cycles/format'
import { cycleInsight } from '../components/cycles/insight'
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

const GUIDE = 'px-3 py-2 border-b border-border-subtle'

const ESTIMATE_TERMS: readonly Term[] = [
  ['Bull run', 'A stretch the model labels EUPHORIA (see the chart guide). Stretches less than 365 days apart count as one run.'],
  ['Run start', 'BREAKOUT dates a run from the start of its final doubling: the first close of the run-up that stays above half the price on the first euphoria day. EUPHORIA dates it from that first euphoria day.'],
  ['Central estimate', 'The median of all candidate dates produced by the four timing methods below.'],
  ['core · range', 'Core is the middle half of the candidate dates (25th to 75th percentile). Range is the earliest to the latest.'],
  ['could peak around', 'Each candidate start plus each completed run\'s start-to-top length; the quarter shown is the median.'],
  ['Phase', 'The cycle phase the model reads today and the first day of the current stretch.'],
  ['Since cycle top', 'Days since the highest close of the latest run. The line under it compares that with the median number of days past cycles took from top to next run start.'],
  ['From top', 'Current price against that top close, with the price itself.'],
  ['Bear low (so far)', 'Lowest close since the top, as a drop from the top. It can still be undercut. "past bears" lists the same drop for each completed cycle.'],
  ['Off the low', 'Current price against that low, with the low price.'],
  ['To ATH', 'How far price must rise to match the all-time-high close, with that close and its date.'],
]

const CHART_TERMS: readonly Term[] = [
  ['Candles', 'Daily or weekly bars (1D / 1W) in USD on a log scale: equal distances are equal percent moves.'],
  ['Background bands', 'The cycle phase on each day (legend at top right). The model sets it from trend and heat, first match wins: CAPITULATION when heat is at most −0.6 within 30 days of a one-year low, or after a 30-day fall of 30% while at least 50% below the high with trend below zero; EUPHORIA when heat is at least 0.75 with trend at least 0.3; ACCUMULATION when heat is at most −0.35 more than 30 days after the low; DISTRIBUTION when heat is at least 0.2 with price under its 50-day average; EXPANSION when trend is at least 0.25; MARKDOWN when trend is at most −0.25; otherwise DISTRIBUTION when heat is above zero and ACCUMULATION when it is not. A change must hold 14 days (5 for euphoria and capitulation) to count, and stretches under 60 days are merged into a neighbour when drawn.'],
  ['SMA200', 'The thin line: mean of the last 200 daily closes.'],
  ['Mayer', 'Price divided by SMA200. 1.00 means price is on the average.'],
  ['drawdown', 'Close against the highest close so far, in percent.'],
  ['trend', 'From −1 to +1. A blend of the Mayer multiple, the 30-day slope of SMA200 and the 50-day average against the 200-day. Positive means rising.'],
  ['heat', 'From −1 to +1. A blend of where the Mayer multiple ranks in its own last 4 years, the drawdown from the high and the 365-day return. High means price is stretched above its averages.'],
  ['Arrows below', 'BTC halving dates. The one to the right of today is a block-time estimate.'],
  ['Dots above', 'Where each past bull run started, by the selected run-start definition. To the right of today: the median estimated start (run) and top.'],
  ['Blue windows', 'Right of today: darker blue is the core estimated run-start window, lighter blue the full range.'],
  ['Top window', 'Right of today, in the euphoria colour: the estimated window for the next cycle top.'],
  ['cooler high', 'An all-time-high leg that peaked on less heat than the leg before. See the table below.'],
  ['FORECAST · COOLER HIGHS', 'Show or hide the estimated windows and the cooler-high arrows.'],
  ['ALL · CYCLE', 'Full history, or from 180 days before the last cycle top through the estimate.'],
]

const ANALOG_TERMS: readonly Term[] = [
  ['Vertical axis', 'Price as a multiple of the cycle-top close, log scale. "top" is the top itself, −50% is half of it, 2× is double.'],
  ['Horizontal axis', 'Days since that cycle\'s top.'],
  ['Lines', 'One per cycle, named by the year of its top. The brightest line is the current cycle. Only the three most recent past cycles are drawn.'],
  ['Dots', 'Where the next bull run started in each past cycle, by the selected run-start definition. "next run +Nd" in the legend is the same day count.'],
  ['today', 'The dashed vertical line: the current cycle\'s day count.'],
  ['Blue band', 'The core estimated run-start window, converted to days since the current top.'],
]

const METHOD_TERMS: readonly Term[] = [
  ['Anchor', 'The date each method counts from for the next run. "est." means the anchor is itself an estimate: the next halving date, or a bear low that can still be undercut.'],
  ['Past offsets → date', 'One line per past cycle: the days from that cycle\'s anchor to its run start, and the date the same gap gives from today\'s anchor. A minus sign means the run started before the anchor.'],
  ['Median', 'The middle of that method\'s candidate dates.'],
  ['Range', 'Its earliest and latest candidate dates.'],
]

const COOLING_TERMS: readonly Term[] = [
  ['Leg', 'A run to a new all-time high. A new leg starts after a pullback of 20% from the high.'],
  ['High · Close', 'Date and closing price of the leg\'s highest close.'],
  ['Heat', 'The heat score that day, from −1 to +1 (see the chart guide). A row appears when it is at least 0.05 below the heat at the previous leg\'s high.'],
  ['Previous high', 'The leg before it, in the same cycle. Legs with a 65% fall between them belong to different cycles and are not compared.'],
  ['Price / heat', 'Change in price and in heat from the previous high to this one.'],
]

const RUNS_TERMS: readonly Term[] = [
  ['Breakout · Euphoria', 'The two ways to date the run start, each with the close that day. The selected one is highlighted.'],
  ['Top', 'Highest close of the run, taken before price fell 65% from its running high.'],
  ['Start→top', 'Days from the selected run start to the top.'],
  ['Bear low', 'Lowest close after the top and before the next run. "provisional" on the latest run: it can still be undercut.'],
  ['Depth', 'The bear low against the top, in percent.'],
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
  const insight = cycleInsight(forecast, shownCoin)
  const sources = Object.entries(body.sources)
    .map(([k, n]) => `${k} ${n.toLocaleString('en-US')}d`)
    .join(' · ')

  return (
    <div className="max-w-[1440px] mx-auto p-3 md:p-[var(--gutter)] flex flex-col gap-3 lg:grid lg:grid-cols-12">
      <div className="lg:col-span-12 flex flex-col gap-1">
        <p className="text-md text-text-primary max-w-[110ch]">
          {insight ?? `The model has not seen a ${shownCoin} bull run in this history yet, so there is no cycle top to measure from.`}
        </p>
        <p className="text-sm text-text-muted max-w-[110ch]">
          This screen places today inside the multi-year cycle and shows when past cycles would put the next bull run. It describes what
          happened in {forecast.episodes.length} past {forecast.episodes.length === 1 ? 'run' : 'runs'}; it is not a prediction.
        </p>
      </div>

      <Panel className="lg:col-span-12">
        <PanelHeader title={`NEXT ${shownCoin} BULL RUN · ESTIMATE`}>
          <span className={`hidden md:inline text-xs text-text-secondary tabular ${loading ? 'pulse-label' : ''}`}>as of {fmtDay(body.asOf)}</span>
          {coinSwitch}
          <Segmented label="Run start" options={KIND_OPTIONS} value={kind} onChange={setKind} />
        </PanelHeader>
        <PanelBody className="p-0">
          <HowToRead className={GUIDE} terms={ESTIMATE_TERMS}>
            When the next bull run would start if the gaps seen in past cycles repeat, pooled from four timing methods, then where today
            sits between the last top and that start. Look at how wide the range is: it comes from a handful of past cycles.
          </HowToRead>
          <ForecastHero forecast={forecast} other={other} />
          <ReadinessStrip forecast={forecast} />
        </PanelBody>
      </Panel>

      <Panel className="lg:col-span-12">
        <PanelHeader title={`CYCLE · ${shownCoin}/USD · LOG`} />
        <PanelBody className="p-0">
          <HowToRead className={GUIDE} terms={CHART_TERMS}>
            Price over bands coloured by the model's cycle phase, with the estimated next-run and next-top windows drawn to the right of
            today. Look at which phase price is in now and how past runs lined up with the halvings.
          </HowToRead>
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
          <HowToRead className={GUIDE} terms={ANALOG_TERMS}>
            Each cycle's price path after its top, measured against the top and lined up by days since it. Look at where the current
            cycle sits against past ones at the same day count.
          </HowToRead>
          <AnalogChart analogs={body.analogs} forecast={forecast} />
        </PanelBody>
      </Panel>

      <Panel className="lg:col-span-6">
        <PanelHeader title="TIMING METHODS" />
        <PanelBody className="p-0">
          <HowToRead className={GUIDE} terms={METHOD_TERMS}>
            Four ways to date the next run start. Each measures past cycles from a different anchor and applies those gaps to today's
            anchor. Look at how far the method medians disagree: that spread is the error bar.
          </HowToRead>
          <MethodsTable forecast={forecast} coin={shownCoin} />
        </PanelBody>
      </Panel>

      <Panel className="lg:col-span-12">
        <PanelHeader title="HIGHER HIGHS ON LOWER HEAT" />
        <PanelBody className="p-0">
          <HowToRead className={GUIDE} terms={COOLING_TERMS}>
            New all-time highs that printed on less heat than the high before them, within one cycle. In past cycles these came late in
            the run: price still rising while the stretch behind it faded. A record of what happened, not a signal.
          </HowToRead>
          <CoolingHighsTable highs={body.coolingHighs} />
        </PanelBody>
      </Panel>

      <Panel className="lg:col-span-12">
        <PanelHeader title="PAST BULL RUNS" />
        <PanelBody className="p-0">
          <HowToRead className={GUIDE} terms={RUNS_TERMS}>
            The past bull runs every estimate above is built on, one row per run. Look at how much start-to-top length and bear depth
            varied: these few rows are the whole sample.
          </HowToRead>
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
