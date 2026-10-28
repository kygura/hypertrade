import { useNavigate } from 'react-router'
import { AgeStamp, AsyncBody, Panel, PanelHeader, StaleBanner } from '../components'
import { LabWarnings } from '../components/LabWarnings'
import { useLabData } from '../components/lab/LabData'
import { PulseBoard } from '../components/lab/PulseBoard'
import { LabFooter } from '../components/lab/common'

// PULSE tab — docs/design/README.md §10.9. Which catalogued rules fire on the latest
// data, aggregated per asset as a lean.

export function LabPulse() {
  const navigate = useNavigate()
  const { pulse, catalogue, metrics } = useLabData()
  const p = pulse.data

  return (
    <Panel>
      <PanelHeader title="MARKET PULSE">{p && <AgeStamp generatedAt={p.asOf} thresholdHours={48} />}</PanelHeader>
      {p && <StaleBanner generatedAt={p.asOf} thresholdHours={48} noun="pulse data" />}
      {p && <LabWarnings warnings={p.warnings} />}
      <AsyncBody
        {...pulse}
        empty={{ label: 'no catalogued rules — nothing to pulse', action: { label: 'SEARCH', onClick: () => navigate('/lab/search') } }}
        isEmpty={(d) => d.assets.length === 0}
        onRetry={pulse.refetch}
      >
        {(d) => (
          <>
            <PulseBoard assets={d.assets} entries={catalogue.data ?? []} metrics={metrics.data ?? []} />
            <LabFooter dataTo={d.asOf.slice(0, 10)} className="px-3 py-2" />
          </>
        )}
      </AsyncBody>
    </Panel>
  )
}
