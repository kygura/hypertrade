import { useSearchParams } from 'react-router'
import { Button, Panel, PanelHeader } from '../../components'
import { EmptyBlock, ErrorBlock, OfflineBlock, SkeletonRows } from '../../components/state'
import { TerminalTabs } from '../../components/intel/TerminalTabs'
import { ClaimAge } from '../../components/intel/ClaimAge'
import { ThesisComposer } from '../../components/intel/ThesisComposer'
import { ThesisDetail, THESIS_STALE_H } from '../../components/intel/ThesisDetail'
import { ThesisList } from '../../components/intel/ThesisList'
import { intel, useIntel } from '../../lib/intel'
import type { Thesis } from '../../../shared/intel'

// `/theses` — write a thesis, see which of its claims the data supports or
// contradicts (DESIGN-terminal §5). `?id=<id>` selects. Desktop: compose +
// saved list (4) beside the detail (8). Mobile: without `?id` compose then
// saved; with `?id` a `← THESES` back button then the detail only, and list
// picks push history (the one exception to §1.1) so Back returns to the list.

const isDesktop = () => typeof window !== 'undefined' && window.matchMedia?.('(min-width: 1024px)').matches

export function Theses() {
  const [params, setParams] = useSearchParams()
  const selectedId = params.get('id')
  const theses = useIntel(() => intel.theses(), [])
  const list = theses.data ?? []
  const selected = selectedId ? (list.find((t) => t.id === selectedId) ?? null) : null

  const select = (id: string | null) => {
    const next = new URLSearchParams(params)
    if (id) next.set('id', id)
    else next.delete('id')
    setParams(next, { replace: isDesktop() || id == null })
  }

  const upsert = (t: Thesis) => {
    const cur = theses.data ?? []
    theses.setData(cur.some((x) => x.id === t.id) ? cur.map((x) => (x.id === t.id ? t : x)) : [t, ...cur])
  }

  const onCreated = (t: Thesis) => {
    upsert(t)
    select(t.id)
  }

  // ── saved list (DESIGN-terminal §10 "Thesis list") ──
  let listBody
  if (theses.loading && !theses.data) listBody = <SkeletonRows />
  else if (theses.offline && !theses.data) listBody = <OfflineBlock onRetry={theses.refetch} />
  else if (theses.error && !theses.data) listBody = <ErrorBlock message={theses.error} onRetry={theses.refetch} />
  else if (list.length === 0) listBody = <EmptyBlock label="no theses yet — write one above" />
  else listBody = <ThesisList theses={list} selectedId={selectedId} onSelect={select} />

  // ── detail ──
  let detailBody
  if (!selectedId) detailBody = <EmptyBlock label="select a thesis" />
  else if (theses.loading && !theses.data) detailBody = <SkeletonRows rows={4} />
  else if (theses.offline && !theses.data) detailBody = <OfflineBlock onRetry={theses.refetch} />
  else if (theses.error && !theses.data) detailBody = <ErrorBlock message={theses.error} onRetry={theses.refetch} />
  else if (!selected) detailBody = <EmptyBlock label="thesis not found" />
  else
    detailBody = (
      <ThesisDetail
        key={selected.id}
        thesis={selected}
        onRecheck={async () => upsert(await intel.checkThesis(selected.id))}
        onDelete={async () => {
          await intel.deleteThesis(selected.id)
          theses.setData(list.filter((t) => t.id !== selected.id))
          select(null)
          return true
        }}
      />
    )

  return (
    <div className="max-w-[1440px] mx-auto px-3 pb-3 md:px-[var(--gutter)] md:pb-[var(--gutter)] flex flex-col">
      <TerminalTabs />
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-3 items-start">
        <div className={`lg:col-span-4 min-w-0 flex-col gap-3 ${selectedId ? 'hidden lg:flex' : 'flex'}`}>
          <Panel>
            <PanelHeader title="COMPOSE" />
            <ThesisComposer onCreated={onCreated} />
          </Panel>
          <Panel>
            <PanelHeader title={theses.data ? `SAVED · ${list.length}` : 'SAVED'} />
            {theses.error && theses.data && <ErrorBlock message={theses.error} onRetry={theses.refetch} />}
            {listBody}
          </Panel>
        </div>

        <div className={`lg:col-span-8 min-w-0 flex-col gap-2 ${selectedId ? 'flex' : 'hidden lg:flex'}`}>
          {selectedId && (
            <div className="lg:hidden">
              <Button tier="ghost" onClick={() => select(null)}>
                ← THESES
              </Button>
            </div>
          )}
          <Panel>
            <PanelHeader title="THESIS">
              {selected &&
                (selected.checkedAt ? (
                  <ClaimAge ts={selected.checkedAt} thresholdHours={THESIS_STALE_H} prefix="LAST CHECKED" />
                ) : (
                  <span className="text-[10px] text-text-secondary">NOT CHECKED</span>
                ))}
            </PanelHeader>
            {detailBody}
          </Panel>
        </div>
      </div>
    </div>
  )
}
