import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { AsyncBody, HowToRead, Panel, PanelHeader, StaleBanner, type Term } from '../components'
import { CatalogueHealthStrip } from '../components/lab/CatalogueHealthStrip'
import { CatalogueTable } from '../components/lab/CatalogueTable'
import { firingIds, useLabData, usePulse } from '../components/lab/LabData'
import { RemoveRuleDialog } from '../components/lab/RemoveRuleDialog'
import { LabFooter } from '../components/lab/common'
import { catalogueLine, dateIso, EVAL_TERMS as T, lab, LIVE_MIN_DAYS, useLab, VERDICT_TERMS, type CatalogueListEntry } from '../lib/lab'

// RULES tab (the catalogue) — docs/design/README.md §10.9. Saved rules with their live record since
// saving, health flags, and the rank key said aloud (LIVE SHARPE — not the
// search's key). SEARCH and RUNS are off the tab row (docs/TASKS.md 2026-11-11); the line under the
// header is their entry point, since they are how a rule gets here.

const LINK = 'text-text-secondary hover:text-text-primary underline-offset-2 hover:underline'

/**
 * The table's columns and the health strip. The decay and overlap cut-offs are the server's (DECAY_MIN_LIVE_DAYS,
 * DECAY_HOLDOUT_SHARE, OVERLAP_JACCARD in src/server/lab/service.ts, docs/LAB.md §9).
 */
const CATALOGUE_TERMS: readonly Term[] = [
  ['LIVE SHARPE', `Sharpe over the days since the rule was saved, which could not have shaped its choice. Shown from ${LIVE_MIN_DAYS} live days; the table is sorted by it. ${T.sharpe[1]}`],
  ['WF', `walk-forward Sharpe when the rule was saved. ${T.walkForward[1]}`],
  ['HOLDOUT', `Sharpe when the rule was saved, on ${T.holdout[1]} The table can never be sorted by it.`],
  ...VERDICT_TERMS.map(([k, v]): Term => [k, `at save time: ${v}`]),
  ['FIRING', 'FIRING = every condition is true on the latest daily bar; FLAT = not. A dash means the pulse has not loaded.'],
  ['DECAYED', `${LIVE_MIN_DAYS} or more live days and a live Sharpe below 0, or below a quarter of the holdout Sharpe the rule was saved with.`],
  ['OVERLAP / OVERLAPS', 'two saved rules on the same asset and side that are in the market on mostly the same days (0.6 or more of the days either is in). They are closer to one bet than two. The number is that share.'],
  ['GAPS', 'an asset in the catalogue with no rule on one side, long or short.'],
  ['SIDE · HOLD', 'side, asset and the horizon in days the rule was searched for.'],
  ['LIVE DAYS', 'days of data since the rule was saved.'],
  ['ORIGIN', 'who saved it: user = you, agent = a research agent through the tools, seed = shipped with the app.'],
  T.untested,
]

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
        <span className="label" title="sorted by the Sharpe since saving, not by the walk-forward number the search ranked on">
          RANKED BY LIVE SHARPE
        </span>
      </PanelHeader>
      <HowToRead terms={CATALOGUE_TERMS} className="px-3 py-2 border-b border-border-subtle">
        The rules you saved, each with how it has done on the days since. Live Sharpe is the one number here that was not available when the rule was chosen; walk-forward and holdout
        show what it looked like then. All of it is past performance.
      </HowToRead>
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
        empty={{ label: 'no saved rules yet: a rule you SAVE from a search or a study lists here and is tracked on new data from that day', action: { label: 'SEARCH', onClick: () => navigate('/lab/search') } }}
        onRetry={catalogue.refetch}
      >
        {() => (
          <>
            {catalogueLine(entries) && <p className="px-3 pt-2 text-md text-text-primary">{catalogueLine(entries)}</p>}
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
