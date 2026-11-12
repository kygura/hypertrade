import type { GaugeKey, VectorResponse } from '../../../shared/vector'
import { HowToRead, type Term } from '../HowToRead'
import { Panel, PanelBody, PanelHeader } from '../Panel'
import { StaleStrip } from '../state'
import { Brief, briefTitle } from './Brief'
import { CompassPanel, COMPASS_TITLE } from './CompassPanel'
import { fmtDate, fmtDeltaPts, fmtInt } from './format'
import { Gauge } from './Gauge'
import { regimeInsight } from './insight'
import { LevelsTable, LEVELS_TITLE } from './LevelsTable'
import { MacroStrip } from './MacroStrip'
import { RegimeChart } from './RegimeChart'
import { RegimeHero } from './RegimeHero'
import { GAUGE_KEYS, GAUGE_LABEL, GAUGE_ZONES, isVectorStale } from './scales'
import { SourcesFooter } from './SourcesFooter'

// VectorView — the hl-cycles Vector block (DESIGN §14.4.9 there) as hypertrade
// panels on the 12-col grid: hero + four gauges (12), regime chart (8) + compass
// (4), levels (5) + brief (7), macro strip (12), sources line (12). Single
// column below lg. Owns no state beyond what the chart and disclosures keep.

const GUIDE = 'px-3 py-2 border-b border-border-subtle'

const REGIME_TERMS: readonly Term[] = [
  ['Regime', 'One of four states, set each day from the share of stress conditions active (risk) and the sign of momentum. Strong risk-on: no condition active, momentum above zero and realized cap up over 30 days. Mild risk-on: at most 25% of conditions active (1 of 6) and momentum above zero. Strong risk-off: at least 50% active and momentum below zero. Mild risk-off: every other case. A new state shows only after it holds for 3 daily closes in a row.'],
  ['% BTC · % cash', 'A fixed label attached to each state by the model: strong risk-on 100% BTC, mild risk-on 66%, mild risk-off 33%, strong risk-off 0%. It restates the state; it is not a position size.'],
  ['since · day', 'First day of the current state and whole days since then.'],
  ['inputs as of', 'Date of the oldest input behind the stress conditions. The amber stale strip shows when an input is more than 10 days behind the last close, or the payload itself is more than 3 days old.'],
  ['Confirm · Invalidate', 'The nearest key level above price (confirm) and below price (invalidate) from the levels table, written as the daily close that would cross it.'],
  ['Stress conditions', 'Six yes/no checks: price below the short-term holder (STH) cost basis; STH-SOPR 7-day mean below 1 (short-term holders selling at a loss on average); price below the True Market Mean; 30-day downside volatility above its 365-day median; stablecoin supply down over 30 days; ETF net outflow over 7 days. Each row shows the measured value and the date of its source.'],
  ['RISK', 'Share of the six stress conditions that are active, 0 to 100. Up to 25 reads low risk, up to 50 elevated, above 50 high risk.'],
  ['MOMENTUM', 'BTC price change over 20, 50 and 200 days, each scaled by a typical move for that span, squashed and averaged into one number from −100 to +100. Above zero means price is up on balance across the three spans. Only the sign feeds the regime.'],
  ['FUNDAMENTALS · FLOWS', 'The compass scores (0 to 100) of the On-chain Fundamentals and Capital Flows lenses, with the lens band as the word. See the compass panel.'],
  ['● ○ |', 'On each dial: filled dot is today, hollow dot is 7 days ago, the tick is the mean of the last 365 days.'],
]

const BRIEF_TERMS: readonly Term[] = [
  ['Title word', 'Where price sits against two on-chain averages. Strong uptrend: above both the STH cost basis and the True Market Mean. Capitulation: below both while the STH cost basis is itself under the True Market Mean. Bear: below both otherwise. Transition: between the two.'],
  ['sessions', 'Daily closes in a row on the same side of the level.'],
  ['flows leg', 'Strong risk-on needs realized cap (the value of all coins at the price they last moved) to be up over 30 days.'],
]

const MACRO_TERMS: readonly Term[] = [
  ['Dollar vs 200D', 'Fed broad trade-weighted dollar index against its own 200-observation average, in percent. Positive means the dollar is above its average.'],
  ['US 10Y · US 2Y', 'Treasury yields in percent.'],
  ['Fed funds', 'Upper bound of the Fed funds target range, in percent.'],
  ['Curve 10Y−2Y', '10-year yield minus 2-year yield, in percentage points. Below zero means the curve is inverted.'],
  ['BTC·SPX corr 30D', 'Correlation of BTC and S&P 500 daily returns over the last 30 S&P trading days, from −1 to +1. Blank with fewer than 10 paired days.'],
  ['as of', 'The oldest date among the series used here.'],
]

export function VectorView({ vector, refreshing, now = Date.now() }: { vector: VectorResponse; refreshing?: boolean; now?: number }) {
  const stale = isVectorStale(vector, now)
  // Fundamentals/flows gauges print the matching lens band so gauge and tile agree.
  const lensBand = (k: GaugeKey) => vector.compass.lenses.find((l) => l.key === k)?.band

  const insight = regimeInsight(vector)

  return (
    <div className="max-w-[1440px] mx-auto p-3 md:p-[var(--gutter)] flex flex-col gap-3 lg:grid lg:grid-cols-12">
      <div className="lg:col-span-12 flex flex-col gap-1">
        <p className="text-md text-text-primary max-w-[110ch]">
          {insight ?? 'No regime reading yet. The model starts once every on-chain and price input has enough history.'}
        </p>
        <p className="text-sm text-text-muted max-w-[110ch]">
          This screen is a daily model of BTC on the high timeframe (days to months). Every word on it, such as risk-on or a band name, is the
          model's label for a measured reading, not a forecast.
        </p>
      </div>

      <Panel className="lg:col-span-12">
        <PanelHeader title="BTC HTF VIEW · REGIME">
          <span className={`text-xs text-text-secondary tabular ${refreshing ? 'pulse-label' : ''}`}>as of {fmtDate(vector.asOf)}</span>
        </PanelHeader>
        <PanelBody className="p-0">
          {stale && <StaleStrip>inputs stale · carrying forward · oldest input {fmtDate(vector.oldestInputAsOf)}</StaleStrip>}
          <HowToRead className={GUIDE} terms={REGIME_TERMS}>
            The regime is the model's read of BTC risk today, with the four dials that feed it. Look at how long the state has held, how many
            stress conditions are active, and whether each dial moved since last week.
          </HowToRead>
          <div className="flex flex-col lg:grid lg:grid-cols-12">
            <div className="lg:col-span-5">
              <RegimeHero regime={vector.regime} asOf={vector.asOf} oldestInputAsOf={vector.oldestInputAsOf} brief={vector.brief} />
            </div>
            <div className="lg:col-span-7 flex flex-col justify-center border-t lg:border-t-0 lg:border-l border-border-subtle">
              <div className="grid grid-cols-2 md:grid-cols-4">
                {GAUGE_KEYS.map((k) => (
                  <Gauge
                    key={k}
                    label={GAUGE_LABEL[k]}
                    reading={vector.gauges[k]}
                    zones={GAUGE_ZONES[k]}
                    fmt={k === 'momentum' ? fmtDeltaPts : fmtInt}
                    word={k === 'fundamentals' || k === 'flows' ? lensBand(k) : undefined}
                  />
                ))}
              </div>
              <div className="px-3 pb-2 text-xs text-text-secondary text-right tabular">● today&nbsp;&nbsp;○ last week&nbsp;&nbsp;| 52w avg</div>
            </div>
          </div>
        </PanelBody>
      </Panel>

      <Panel className="lg:col-span-8">
        <PanelHeader title="REGIME · BTC/USD DAILY · LOG" />
        <PanelBody className="p-0">
          <RegimeChart history={vector.history} flips={vector.flips} levels={vector.levels} asOf={vector.asOf} />
        </PanelBody>
      </Panel>

      <Panel className="lg:col-span-4">
        <PanelHeader title={COMPASS_TITLE} />
        <PanelBody className="p-0">
          <CompassPanel compass={vector.compass} />
        </PanelBody>
      </Panel>

      <Panel className="lg:col-span-5">
        <PanelHeader title={LEVELS_TITLE} />
        <PanelBody className="p-0">
          <LevelsTable levels={vector.levels} price={vector.price} />
        </PanelBody>
      </Panel>

      <Panel className="lg:col-span-7">
        <PanelHeader title={briefTitle(vector.wocPhase)} />
        <PanelBody className="p-0">
          <HowToRead className={GUIDE} terms={BRIEF_TERMS}>
            Sentences filled in by code from today's numbers: the regime, two cost-basis levels, momentum, flows and the compass. Each states
            a measurement and the threshold that would change it; none is written by a language model.
          </HowToRead>
          <Brief brief={vector.brief} />
        </PanelBody>
      </Panel>

      <Panel className="lg:col-span-12">
        <PanelHeader title="MACRO · CONTEXT">
          <span className="text-xs text-text-secondary tabular">as of {fmtDate(vector.macro.asOf)}</span>
        </PanelHeader>
        <PanelBody className="p-0">
          <HowToRead className={GUIDE} terms={MACRO_TERMS}>
            Rates, the dollar and BTC's link to US stocks, as background to the regime. These also feed the compass Macro lens. No colour is
            applied because no direction is scored here.
          </HowToRead>
          <MacroStrip macro={vector.macro} />
        </PanelBody>
      </Panel>

      <div className="lg:col-span-12">
        <SourcesFooter sources={vector.sources} now={now} />
      </div>
    </div>
  )
}
