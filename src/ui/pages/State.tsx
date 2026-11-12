import { useState } from 'react'
import { Panel, PanelHeader, PanelBody } from '../components/Panel'
import { AgeStamp, StaleBanner, SkeletonRows, EmptyBlock, ErrorBlock, OfflineBlock } from '../components/state'
import { Button } from '../components/Button'
import { HowToRead, type Term } from '../components/HowToRead'
import { useApi } from '../lib/api'
import { fmtUtcStamp } from '../lib/format'
import { DomainCard } from '../components/state/DomainCard'
import { ThesisBlock } from '../components/state/ThesisBlock'
import { HistoryStepper } from '../components/state/HistoryStepper'
import { TriggerRoutineButton } from '../components/state/TriggerRoutineButton'
import type { MarketStateData } from '../../shared/types'

// /state — docs/design/README.md §10.6. The reading surface: 760px column, single xl
// element (the headline), Observe/Infer/Forecast thesis, domain cards,
// risks verbatim, history stepper, trigger button.

type LatestResponse = MarketStateData & { history: string[] }

const TERMS: readonly Term[] = [
  ['Headline · summary', 'The routine\'s one-line read of the market and a short summary under it.'],
  ['OBSERVE', 'What the collected data showed. This part restates measurements.'],
  ['INFER', 'What the routine concludes from those observations. Interpretation, not measurement.'],
  ['FORECAST', 'What the routine expects next. A hypothesis; nothing on this page checks it.'],
  ['Domain cards', 'One card per area the routine covers, each with its own summary and the signals it cited. ▲ or ▼ beside a value is the direction the routine recorded for that signal.'],
  ['RISKS', 'What the routine says could prove its read wrong, in its own words.'],
  ['Date stepper', 'Moves through earlier briefings. A bar under the header shows when you are not on the latest.'],
  ['Age stamp', 'Time since the briefing was written. A banner appears once it is more than 24 hours old.'],
]

function fullStamp(iso: string): string {
  return fmtUtcStamp(iso)
}

export function State() {
  const { data: latest, loading, error, offline, refetch } = useApi<LatestResponse>('/marketstate')
  const [viewDate, setViewDate] = useState<string | null>(null)

  const latestDate = latest?.generated_at.slice(0, 10) ?? null
  const isHistorical = viewDate != null && viewDate !== latestDate
  const { data: historical } = useApi<MarketStateData>(isHistorical ? `/marketstate/history/${viewDate}` : null)

  // Keep showing the previous snapshot while a history fetch is in flight
  // rather than flashing empty content — refetches never re-show skeletons.
  const briefing = isHistorical ? (historical ?? latest) : latest

  return (
    <div className="max-w-[1440px] mx-auto p-3 md:p-[var(--gutter)]">
      <div className="max-w-[760px] mx-auto flex flex-col gap-4">
        {loading && <SkeletonRows />}
        {!loading && offline && <OfflineBlock onRetry={refetch} />}
        {!loading && !offline && error && <ErrorBlock message={error} onRetry={refetch} />}

        {latest && latest.history.length === 0 && (
          <Panel>
            <PanelBody className="p-3 flex flex-col items-center gap-3">
              <EmptyBlock label="No briefing yet. The scheduled routine writes one per run from the collected market data; trigger it below to produce the first." />
              <TriggerRoutineButton />
            </PanelBody>
          </Panel>
        )}

        {briefing && (
          <>
            <Panel>
              <StaleBanner generatedAt={briefing.generated_at} thresholdHours={24} noun="briefing" />
              <PanelHeader title="MARKETSTATE">
                <span className="flex items-center gap-1.5 text-xs text-text-secondary tabular">
                  <AgeStamp generatedAt={briefing.generated_at} thresholdHours={24} />
                  <span>· {fullStamp(briefing.generated_at)}</span>
                </span>
              </PanelHeader>
              <PanelBody className="p-3 flex flex-col md:flex-row md:items-center md:justify-between gap-3">
                {latest && (
                  <HistoryStepper dates={latest.history} current={viewDate ?? latestDate ?? ''} onChange={setViewDate} />
                )}
                <TriggerRoutineButton />
              </PanelBody>
            </Panel>

            {isHistorical && (
              <div className="flex items-center justify-between gap-2 px-3 py-1.5 text-sm bg-info-bg text-info">
                <span>
                  viewing {viewDate} — not the latest briefing
                </span>
                <Button tier="ghost" onClick={() => setViewDate(null)}>
                  LATEST
                </Button>
              </div>
            )}

            <HowToRead terms={TERMS}>
              A market briefing written by the scheduled model routine from collected data. Read OBSERVE as what was measured and INFER
              and FORECAST as the routine's interpretation.
            </HowToRead>

            <div>
              <h1 className="text-xl leading-snug text-text-primary">{briefing.headline}</h1>
              <p className="mt-2 text-base text-text-muted">{briefing.tldr}</p>
            </div>

            <ThesisBlock thesis={briefing.thesis} />

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {briefing.domains.map((d) => (
                <DomainCard key={d.domain} domain={d} />
              ))}
            </div>

            <Panel>
              <PanelHeader title="RISKS" />
              <PanelBody className="p-3 flex flex-col gap-1.5">
                {briefing.risks.map((r, i) => (
                  <div key={i} className="flex items-start gap-2 text-base text-text-muted">
                    <span className="mt-1.5 w-1.5 h-1.5 bg-red flex-shrink-0" />
                    <span>{r}</span>
                  </div>
                ))}
              </PanelBody>
            </Panel>
          </>
        )}
      </div>
    </div>
  )
}
