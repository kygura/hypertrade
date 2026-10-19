import { useState } from 'react'
import { Panel, PanelHeader, PanelBody } from '../components/Panel'
import { ErrorBlock, OfflineBlock, SkeletonRows } from '../components/state'
import { useApi } from '../lib/api'
import { CycleChart } from '../components/cycles/CycleChart'
import { AnalogChart } from '../components/cycles/AnalogChart'
import { EpisodesTable, ForecastHero, MethodsTable, ReadinessStrip } from '../components/cycles/ForecastPanel'
import { fmtDay } from '../components/cycles/format'
import type { CyclesResponse } from '../../shared/cycles'

// /cycles — the hl-cycles BTC cycle view (phase-banded log chart, SMA200,
// halvings) with a next-bull-run estimate layered on: headline window and
// readiness strip, the chart with the projected window, cycle analogs from
// the top, the four timing methods, and the past runs they're built on.

export function Cycles() {
  const [tf, setTf] = useState<'1d' | '1w'>('1d')
  // useApi keeps the previous body while a timeframe switch loads.
  const { data: body, loading, error, offline, refetch } = useApi<CyclesResponse>(`/cycles?tf=${tf}`)

  if (!body) {
    return (
      <div className="max-w-[1440px] mx-auto p-3 md:p-[var(--gutter)]">
        {loading && (
          <div className="flex flex-col gap-2">
            <SkeletonRows />
            <span className="text-[10px] text-text-secondary text-center pulse-label">loading BTC history since 2011…</span>
          </div>
        )}
        {!loading && offline && <OfflineBlock onRetry={refetch} />}
        {!loading && !offline && error && <ErrorBlock message={error} onRetry={refetch} />}
      </div>
    )
  }

  const { forecast } = body
  const sources = Object.entries(body.sources)
    .map(([k, n]) => `${k} ${n.toLocaleString('en-US')}d`)
    .join(' · ')

  return (
    <div className="max-w-[1440px] mx-auto p-3 md:p-[var(--gutter)] flex flex-col gap-3 lg:grid lg:grid-cols-12">
      <Panel className="lg:col-span-12">
        <PanelHeader title="NEXT BULL RUN · ESTIMATE">
          <span className="text-[10px] text-text-secondary tabular">BTC · as of {fmtDay(body.asOf)}</span>
        </PanelHeader>
        <PanelBody className="p-0">
          <ForecastHero forecast={forecast} />
          <ReadinessStrip forecast={forecast} />
        </PanelBody>
      </Panel>

      <Panel className="lg:col-span-12">
        <PanelHeader title="CYCLE · BTC/USD · LOG" />
        <PanelBody className="p-0">
          <CycleChart
            bars={body.bars}
            halvings={body.halvings}
            nextHalving={body.nextHalving}
            forecast={forecast}
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
          <MethodsTable forecast={forecast} />
        </PanelBody>
      </Panel>

      <Panel className="lg:col-span-12">
        <PanelHeader title="PAST BULL RUNS" />
        <PanelBody className="p-0">
          <EpisodesTable episodes={forecast.episodes} />
          <p className="px-3 py-2 text-[11px] text-text-secondary border-t border-border-subtle">
            Four cycles is a small sample and the spread between methods is the honest error bar. This bear market bottomed shallower than every
            past one so far; a lower low would move the bear-low anchor, and the estimate with it, later. Halving date is a block-time estimate.
            Not financial advice. History: {sources}.
          </p>
        </PanelBody>
      </Panel>
    </div>
  )
}
