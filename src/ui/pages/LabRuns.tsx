import { useNavigate } from 'react-router'
import { EmptyBlock, ErrorBlock, OfflineBlock, Panel, PanelHeader, SkeletonRows } from '../components'
import { RunsTable } from '../components/lab/RunsTable'
import { lab, useLab } from '../lib/lab'

// RUNS tab — DESIGN.md §10.9. Recent runs from every client (ui, mcp, cli);
// a row opens the run in the SEARCH layout.

export function LabRuns() {
  const navigate = useNavigate()
  const runs = useLab(() => lab.listRuns(), [])

  let body: React.ReactNode
  if (runs.loading && !runs.data) body = <SkeletonRows />
  else if (runs.offline && !runs.data) body = <OfflineBlock onRetry={runs.refetch} />
  else if (runs.error && !runs.data) body = <ErrorBlock message={runs.error} onRetry={runs.refetch} />
  else if (!runs.data || runs.data.length === 0) body = <EmptyBlock label="no runs yet" />
  else body = <RunsTable runs={runs.data} onOpen={(r) => navigate(`/lab/runs/${encodeURIComponent(r.id)}`)} />

  return (
    <Panel>
      <PanelHeader title="RUNS" />
      {runs.error && runs.data && <ErrorBlock message={runs.error} onRetry={runs.refetch} />}
      {body}
    </Panel>
  )
}
