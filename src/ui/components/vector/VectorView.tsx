import type { GaugeKey, VectorResponse } from '../../../shared/vector'
import { Panel, PanelBody, PanelHeader } from '../Panel'
import { StaleStrip } from '../state'
import { Brief, briefTitle } from './Brief'
import { CompassPanel, COMPASS_TITLE } from './CompassPanel'
import { fmtDate, fmtDeltaPts, fmtInt } from './format'
import { Gauge } from './Gauge'
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

export function VectorView({ vector, refreshing, now = Date.now() }: { vector: VectorResponse; refreshing?: boolean; now?: number }) {
  const stale = isVectorStale(vector, now)
  // Fundamentals/flows gauges print the matching lens band so gauge and tile agree.
  const lensBand = (k: GaugeKey) => vector.compass.lenses.find((l) => l.key === k)?.band

  return (
    <div className="max-w-[1440px] mx-auto p-3 md:p-[var(--gutter)] flex flex-col gap-3 lg:grid lg:grid-cols-12">
      <Panel className="lg:col-span-12">
        <PanelHeader title="BTC VECTOR · REGIME">
          <span className={`text-xs text-text-secondary tabular ${refreshing ? 'pulse-label' : ''}`}>as of {fmtDate(vector.asOf)}</span>
        </PanelHeader>
        <PanelBody className="p-0">
          {stale && <StaleStrip>inputs stale · carrying forward · oldest input {fmtDate(vector.oldestInputAsOf)}</StaleStrip>}
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
          <Brief brief={vector.brief} />
        </PanelBody>
      </Panel>

      <Panel className="lg:col-span-12">
        <PanelHeader title="MACRO · CONTEXT">
          <span className="text-xs text-text-secondary tabular">as of {fmtDate(vector.macro.asOf)}</span>
        </PanelHeader>
        <PanelBody className="p-0">
          <MacroStrip macro={vector.macro} />
        </PanelBody>
      </Panel>

      <div className="lg:col-span-12">
        <SourcesFooter sources={vector.sources} now={now} />
      </div>
    </div>
  )
}
