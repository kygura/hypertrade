import { useNavigate } from 'react-router'
import { AsyncBody, HowToRead, Panel, PanelHeader, type Term } from '../components'
import { RunsTable } from '../components/lab/RunsTable'
import { LabFooter } from '../components/lab/common'
import { lab, useLab } from '../lib/lab'

// RUNS tab — docs/design/README.md §10.9. Recent runs from every client (ui, mcp, cli);
// a row opens the run in the SEARCH layout. Footer (rule 3):
// data age, dated by the newest run (no run's data reaches past its start).

const RUNS_TERMS: readonly Term[] = [
  ['STARTED', 'how long ago the search ran.'],
  ['SEARCH', 'asset, side (L long, S short) and horizon in days: BTC·L·14D is a long search on BTC with a 14-day horizon.'],
  ['BEST WF SHARPE', 'the highest walk-forward Sharpe among the rules the run kept. It is the best of many tries, so it overstates what to expect; the rule\'s deflated Sharpe corrects for that. A dash means the run had no walk-forward.'],
  ['RULES', 'rules the run kept.'],
  ['STATUS', 'OK or FAILED (hover a failure for the error).'],
  ['METRICS', 'number of metrics the search was given.'],
  ['SOURCE', 'where the run was started: ui = this page, mcp = an agent over MCP, cli = the command line.'],
]

export function LabRuns() {
  const navigate = useNavigate()
  const runs = useLab(() => lab.listRuns(), [])

  return (
    <Panel>
      <PanelHeader title="RUNS" />
      <HowToRead terms={RUNS_TERMS} className="px-3 py-2 border-b border-border-subtle">
        Every stored search, newest first, from this page, the command line and agents. A row opens the run with its settings and the rules it kept. Each run is a batch of past
        backtests.
      </HowToRead>
      <AsyncBody {...runs} empty={{ label: 'no runs yet: each search you run is stored and lists here' }} onRetry={runs.refetch}>
        {(data) => {
          const newest = data.reduce((max, r) => (r.createdAt > max ? r.createdAt : max), '')
          return (
            <>
              <RunsTable runs={data} onOpen={(r) => navigate(`/lab/runs/${encodeURIComponent(r.id)}`)} />
              <LabFooter dataTo={newest.slice(0, 10) || null} className="px-3 py-2 border-t border-border-subtle" />
            </>
          )
        }}
      </AsyncBody>
    </Panel>
  )
}
