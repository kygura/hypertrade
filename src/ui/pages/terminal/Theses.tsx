import { useSearchParams } from 'react-router'
import { Button, Panel, PanelHeader } from '../../components'
import { AsyncBody, EmptyBlock } from '../../components/state'
import { TerminalTabs } from '../../components/intel/TerminalTabs'
import { ClaimAge } from '../../components/intel/ClaimAge'
import { isDesktop } from '../../components/intel/format'
import { ThesisComposer } from '../../components/intel/ThesisComposer'
import { ThesisDetail, THESIS_STALE_H } from '../../components/intel/ThesisDetail'
import { ThesisList } from '../../components/intel/ThesisList'
import { useQueryPatch } from '../../lib/hooks'
import { intel, useIntel } from '../../lib/intel'
import type { Thesis } from '../../../shared/intel'

// `/theses` — write a thesis, see which of its claims the data supports or
// contradicts (DESIGN-terminal §5). `?id=<id>` selects. Desktop: compose +
// saved list (4) beside the detail (8). Mobile: without `?id` compose then
// saved; with `?id` a `← THESES` back button then the detail only, and list
// picks push history (the one exception to §1.1) so Back returns to the list.

export function Theses() {
  const [params] = useSearchParams()
  const patch = useQueryPatch()
  const selectedId = params.get('id')
  const theses = useIntel(() => intel.theses(), [])
  const list = theses.data ?? []
  const selected = selectedId ? (list.find((t) => t.id === selectedId) ?? null) : null

  const select = (id: string | null) => patch({ id }, !(isDesktop() || id == null))

  const upsert = (t: Thesis) => {
    const cur = theses.data ?? []
    theses.setData(cur.some((x) => x.id === t.id) ? cur.map((x) => (x.id === t.id ? t : x)) : [t, ...cur])
  }

  const onCreated = (t: Thesis) => {
    upsert(t)
    select(t.id)
  }

  // ── detail ──
  const detailBody = !selectedId ? (
    <EmptyBlock label="select a thesis" />
  ) : (
    <AsyncBody {...theses} offline={!!theses.offline} rows={4} staleError={false} onRetry={theses.refetch}>
      {() =>
        selected ? (
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
        ) : (
          <EmptyBlock label="thesis not found" />
        )
      }
    </AsyncBody>
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
            <AsyncBody {...theses} offline={!!theses.offline} empty={{ label: 'no theses yet — write one above' }} onRetry={theses.refetch}>
              {(d) => <ThesisList theses={d} selectedId={selectedId} onSelect={select} />}
            </AsyncBody>
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
                  <span className="text-xs text-text-secondary">NOT CHECKED</span>
                ))}
            </PanelHeader>
            {detailBody}
          </Panel>
        </div>
      </div>
    </div>
  )
}
