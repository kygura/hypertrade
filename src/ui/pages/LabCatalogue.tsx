import { useState } from 'react'
import { useNavigate } from 'react-router'
import { AsyncBody, Panel, PanelHeader, StaleBanner } from '../components'
import { CatalogueHealthStrip } from '../components/lab/CatalogueHealthStrip'
import { CatalogueTable } from '../components/lab/CatalogueTable'
import { firingIds, useLabData } from '../components/lab/LabData'
import { RemoveRuleDialog } from '../components/lab/RemoveRuleDialog'
import { LabFooter } from '../components/lab/common'
import { dateIso, lab, useLab, type CatalogueListEntry } from '../lib/lab'

// CATALOGUE tab — docs/design/README.md §10.9. Saved rules with their live record since
// saving, health flags, and the rank key said aloud (LIVE SHARPE — not the
// search's key).

export function LabCatalogue() {
  const navigate = useNavigate()
  const { catalogue, pulse, metrics } = useLabData()
  const health = useLab(() => lab.health(), [])
  const [removing, setRemoving] = useState<CatalogueListEntry | null>(null)
  const entries = catalogue.data ?? []
  const liveTo = entries.reduce<string | null>((max, e) => (e.live && (!max || e.live.to > max) ? e.live.to : max), null)

  return (
    <Panel>
      <PanelHeader title={catalogue.data ? `CATALOGUE · ${entries.length}` : 'CATALOGUE'}>
        <span className="label">RANKED BY LIVE SHARPE</span>
      </PanelHeader>
      {liveTo && <StaleBanner generatedAt={dateIso(liveTo)} thresholdHours={48} noun="live data" />}
      <AsyncBody
        {...catalogue}
        empty={{ label: 'no saved rules — search, then SAVE one', action: { label: 'SEARCH', onClick: () => navigate('/lab/search') } }}
        onRetry={catalogue.refetch}
      >
        {() => (
          <>
            <CatalogueHealthStrip health={health} entries={entries} />
            <CatalogueTable
              entries={entries}
              metrics={metrics.data ?? []}
              firing={firingIds(pulse.data)}
              health={health.data}
              onOpen={(e) => navigate(`/lab/rules/${encodeURIComponent(e.id)}?from=catalogue`)}
              onRemove={setRemoving}
            />
            <LabFooter dataTo={liveTo} className="px-3 py-2 border-t border-border-subtle" />
          </>
        )}
      </AsyncBody>
      {removing && (
        <RemoveRuleDialog
          entry={removing}
          onCancel={() => setRemoving(null)}
          onRemoved={() => {
            setRemoving(null)
            catalogue.refetch()
            pulse.refetch()
            health.refetch()
          }}
        />
      )}
    </Panel>
  )
}
