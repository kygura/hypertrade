import { useNavigate } from 'react-router'
import { AsyncBody, Panel, PanelHeader } from '../components'
import { RunsTable } from '../components/lab/RunsTable'
import { LabFooter } from '../components/lab/common'
import { lab, useLab } from '../lib/lab'

// RUNS tab — docs/design/README.md §10.9. Recent runs from every client (ui, mcp, cli);
// a row opens the run in the SEARCH layout. Footer (rule 3):
// data age, dated by the newest run (no run's data reaches past its start).

export function LabRuns() {
  const navigate = useNavigate()
  const runs = useLab(() => lab.listRuns(), [])

  return (
    <Panel>
      <PanelHeader title="RUNS" />
      <AsyncBody {...runs} empty={{ label: 'no runs yet' }} onRetry={runs.refetch}>
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
