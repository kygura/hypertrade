import { useNavigate } from 'react-router'
import { AgeStamp, AsyncBody, HowToRead, Panel, PanelHeader, StaleBanner, type Term } from '../components'
import { LabWarnings } from '../components/LabWarnings'
import { useLabData, usePulse } from '../components/lab/LabData'
import { PulseBoard } from '../components/lab/PulseBoard'
import { LabFooter } from '../components/lab/common'
import { pulseLine } from '../lib/lab'

// PULSE tab — docs/design/README.md §10.9. Which catalogued rules fire on the latest
// data, aggregated per asset as a lean.

const PULSE_TERMS: readonly Term[] = [
  ['LEAN', 'saved long rules firing minus saved short rules firing, divided by all saved rules on the asset. +1 = every rule is long and firing, −1 = every rule is short and firing, 0 = none firing or the two sides cancel. It counts rules, it does not weigh how good they are.'],
  ['bar', 'the same number drawn: right of the centre tick is net long, left is net short.'],
  ['LONG 2/3 · SHORT 0/1', 'rules firing out of rules saved, per side.'],
  ['● / ○', 'in the opened list: ● the rule is firing (every condition true on the latest daily bar), ○ it is flat.'],
]

export function LabPulse() {
  const navigate = useNavigate()
  const { catalogue, metrics } = useLabData()
  const pulse = usePulse()
  const p = pulse.data

  return (
    <Panel>
      <PanelHeader title="MARKET PULSE">{p && <AgeStamp generatedAt={p.asOf} thresholdHours={48} />}</PanelHeader>
      {p && <StaleBanner generatedAt={p.asOf} thresholdHours={48} noun="pulse data" />}
      {p && <LabWarnings warnings={p.warnings} />}
      <HowToRead terms={PULSE_TERMS} className="px-3 py-2 border-b border-border-subtle">
        Which of your saved rules have all their conditions true on the latest daily bar, per asset. A firing rule is a condition that is met today, nothing more: check the rule's own
        record before reading anything into it.
      </HowToRead>
      <AsyncBody
        {...pulse}
        empty={{ label: 'no saved rules, so nothing to check. Rules you save are tested here against the latest daily bar', action: { label: 'SEARCH', onClick: () => navigate('/lab/search') } }}
        isEmpty={(d) => d.assets.length === 0}
        onRetry={pulse.refetch}
      >
        {(d) => (
          <>
            {pulseLine(d.assets) && <p className="px-3 pt-2 text-md text-text-primary">{pulseLine(d.assets)}</p>}
            <PulseBoard assets={d.assets} entries={catalogue.data ?? []} metrics={metrics.data ?? []} />
            <LabFooter dataTo={d.asOf.slice(0, 10)} className="px-3 py-2" />
          </>
        )}
      </AsyncBody>
    </Panel>
  )
}
