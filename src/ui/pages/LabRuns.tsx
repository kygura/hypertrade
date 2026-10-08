import { useNavigate } from 'react-router'
import { EmptyBlock, ErrorBlock, OfflineBlock, Panel, PanelHeader, SkeletonRows } from '../components'
import { RunsTable } from '../components/lab/RunsTable'
import { LabFooter } from '../components/lab/common'
import { lab, useLab } from '../lib/lab'

// RUNS tab — DESIGN.md §10.9. Recent runs from every client (ui, mcp, cli);
// a row opens the run in the SEARCH layout. Footer (rule 3): disclaimer +
// data age, dated by the newest run (no run's data reaches past its start).

export function LabRuns() {
  const navigate = useNavigate()
  const runs = useLab(() => lab.listRuns(), [])

  let body: React.ReactNode
  if (runs.loading && !runs.data) body = <SkeletonRows />
  else if (runs.offline && !runs.data) body = <OfflineBlock onRetry={runs.refetch} />
  else if (runs.error && !runs.data) body = <ErrorBlock message={runs.error} onRetry={runs.refetch} />
  else if (!runs.data || runs.data.length === 0) body = <EmptyBlock label="no runs yet" />
  else {
    const newest = runs.data.reduce((max, r) => (r.createdAt > max ? r.createdAt : max), '')
    body = (
      <>
        <RunsTable runs={runs.data} onOpen={(r) => navigate(`/lab/runs/${encodeURIComponent(r.id)}`)} />
        <LabFooter dataTo={newest.slice(0, 10) || null} className="px-3 py-2 border-t border-border-subtle" />
      </>
    )
  }

  return (
    <Panel>
      <PanelHeader title="RUNS" />
      {runs.error && runs.data && <ErrorBlock message={runs.error} onRetry={runs.refetch} />}
      {body}
    </Panel>
  )
}
