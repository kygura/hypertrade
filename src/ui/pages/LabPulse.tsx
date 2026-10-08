import { useNavigate } from 'react-router'
import { AgeStamp, EmptyBlock, ErrorBlock, OfflineBlock, Panel, PanelHeader, SkeletonRows, StaleBanner } from '../components'
import { LabWarnings } from '../components/LabWarnings'
import { useLabData } from '../components/lab/LabData'
import { PulseBoard } from '../components/lab/PulseBoard'
import { LabFooter } from '../components/lab/common'

// PULSE tab — DESIGN.md §10.9. Which catalogued rules fire on the latest
// data, aggregated per asset as a lean.

export function LabPulse() {
  const navigate = useNavigate()
  const { pulse, catalogue, metrics } = useLabData()
  const p = pulse.data

  let body: React.ReactNode
  if (pulse.loading && !p) body = <SkeletonRows />
  else if (pulse.offline && !p) body = <OfflineBlock onRetry={pulse.refetch} />
  else if (pulse.error && !p) body = <ErrorBlock message={pulse.error} onRetry={pulse.refetch} />
  else if (!p || p.assets.length === 0)
    body = <EmptyBlock label="no catalogued rules — nothing to pulse" action={{ label: 'SEARCH', onClick: () => navigate('/lab/search') }} />
  else
    body = (
      <>
        <PulseBoard assets={p.assets} entries={catalogue.data ?? []} metrics={metrics.data ?? []} />
        <LabFooter dataTo={p.asOf.slice(0, 10)} className="px-3 py-2" />
      </>
    )

  return (
    <Panel>
      <PanelHeader title="MARKET PULSE">{p && <AgeStamp generatedAt={p.asOf} thresholdHours={48} />}</PanelHeader>
      {p && <StaleBanner generatedAt={p.asOf} thresholdHours={48} noun="pulse data" />}
      {p && <LabWarnings warnings={p.warnings} />}
      {pulse.error && p && <ErrorBlock message={pulse.error} onRetry={pulse.refetch} />}
      {body}
    </Panel>
  )
}
