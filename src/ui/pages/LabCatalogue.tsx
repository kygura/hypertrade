import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { AsyncBody, Panel, PanelHeader, StaleBanner } from '../components'
import { CatalogueHealthStrip } from '../components/lab/CatalogueHealthStrip'
import { CatalogueTable } from '../components/lab/CatalogueTable'
import { firingIds, useLabData, usePulse } from '../components/lab/LabData'
import { RemoveRuleDialog } from '../components/lab/RemoveRuleDialog'
import { LabFooter } from '../components/lab/common'
import { dateIso, lab, useLab, type CatalogueListEntry } from '../lib/lab'

// RULES tab (the catalogue) — docs/design/README.md §10.9. Saved rules with their live record since
// saving, health flags, and the rank key said aloud (LIVE SHARPE — not the
// search's key). SEARCH and RUNS are off the tab row (docs/TASKS.md 2026-11-11); the line under the
// header is their entry point, since they are how a rule gets here.

const LINK = 'text-text-secondary hover:text-text-primary underline-offset-2 hover:underline'

export function LabCatalogue() {
  const navigate = useNavigate()
  const { catalogue, metrics } = useLabData()
  const pulse = usePulse()
  const health = useLab(() => lab.health(), [])
  const [removing, setRemoving] = useState<CatalogueListEntry | null>(null)
  const entries = catalogue.data ?? []
  const liveTo = entries.reduce<string | null>((max, e) => (e.live && (!max || e.live.to > max) ? e.live.to : max), null)

  return (
    <Panel>
      <PanelHeader title={catalogue.data ? `CATALOGUE · ${entries.length}` : 'CATALOGUE'}>
        <span className="label">RANKED BY LIVE SHARPE</span>
      </PanelHeader>
      <p className="px-3 py-1.5 text-xs text-text-secondary border-b border-border-subtle">
        add a rule:{' '}
        <Link to="/lab/search" className={LINK}>
          SEARCH
        </Link>
        {' · '}
        <Link to="/lab/runs" className={LINK}>
          RUNS
        </Link>
      </p>
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
