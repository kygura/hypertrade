import { useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import { Button, EmptyBlock, ErrorBlock, OfflineBlock, Panel, PanelBody, PanelHeader, SkeletonRows } from '../../components'
import { TerminalTabs } from '../../components/intel/TerminalTabs'
import { WatchesTable } from '../../components/intel/WatchesTable'
import { WatchForm } from '../../components/intel/WatchForm'
import { WatchChanges } from '../../components/intel/WatchChanges'
import { INTEL_POLL_MS, intel, useIntel } from '../../lib/intel'

// `/watch` — doc/contract/wallet watches (DESIGN-terminal §8); `?id=` selects.
// Desktop: WATCHES (5) | CHANGES (7). Mobile: without `?id` the list + add
// form; with `?id` `← WATCHES` then CHANGES. Selecting writes `?id` with
// replace, except on mobile where it pushes so back returns to the list (the
// §5.1 rule this route shares).

function isMobile(): boolean {
  try {
    return globalThis.matchMedia?.('(max-width: 767px)').matches ?? false
  } catch {
    return false
  }
}

export function Watch() {
  const [params, setParams] = useSearchParams()
  const selectedId = params.get('id')
  const watches = useIntel(() => intel.watches(), [], { intervalMs: INTEL_POLL_MS.watches })
  const [adding, setAdding] = useState(false)
  const openerRef = useRef<HTMLButtonElement>(null)

  const select = (id: string | null, push = false) => {
    const next = new URLSearchParams(params)
    if (id) next.set('id', id)
    else next.delete('id')
    setParams(next, { replace: !push })
  }

  const closeForm = () => {
    setAdding(false)
    requestAnimationFrame(() => openerRef.current?.focus())
  }

  const list = watches.data ?? []
  const selected = selectedId ? list.find((w) => w.id === selectedId) ?? null : null

  return (
    <div className="max-w-[1440px] mx-auto px-3 pb-3 md:px-[var(--gutter)] md:pb-[var(--gutter)] flex flex-col gap-3">
      <TerminalTabs />
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-3 items-start">
        <div className={`lg:col-span-5 ${selectedId ? 'hidden lg:block' : ''}`}>
          <Panel>
            <PanelHeader title={watches.data ? `WATCHES · ${list.length}` : 'WATCHES'} />
            <PanelBody className="p-0">
              {watches.loading && !watches.data ? (
                <SkeletonRows rows={4} />
              ) : watches.offline && !watches.data ? (
                <OfflineBlock message={watches.offline} onRetry={watches.refetch} />
              ) : watches.error && !watches.data ? (
                <ErrorBlock message={watches.error} onRetry={watches.refetch} />
              ) : list.length === 0 && !adding ? (
                <EmptyBlock label="nothing watched — add a doc page, contract or wallet" action={{ label: 'ADD WATCH', onClick: () => setAdding(true) }} />
              ) : (
                <WatchesTable watches={list} selectedId={selectedId} onSelect={(id) => select(id, isMobile())} />
              )}
              {watches.data && watches.error && <ErrorBlock message={watches.error} onRetry={watches.refetch} />}
              {adding ? (
                <WatchForm
                  onCancel={closeForm}
                  onAdded={(w) => {
                    setAdding(false)
                    watches.refetch()
                    select(w.id, isMobile())
                  }}
                />
              ) : (
                (watches.data?.length ?? 0) > 0 && (
                  <div className="p-3 border-t border-border-subtle">
                    <Button tier="ghost" ref={openerRef} onClick={() => setAdding(true)}>
                      + ADD WATCH
                    </Button>
                  </div>
                )
              )}
            </PanelBody>
          </Panel>
        </div>
        <div className={`lg:col-span-7 ${selectedId ? '' : 'hidden lg:block'}`}>
          {selectedId && (
            <div className="mb-2 lg:hidden">
              <Button tier="ghost" onClick={() => select(null)}>
                ← WATCHES
              </Button>
            </div>
          )}
          {selected ? (
            <WatchChanges key={selected.id} watch={selected} onChecked={watches.refetch} onDeleted={() => {
              select(null)
              watches.refetch()
            }} />
          ) : (
            <Panel>
              <PanelHeader title="CHANGES" />
              <PanelBody>
                {selectedId && watches.loading && !watches.data ? (
                  <SkeletonRows rows={3} />
                ) : (
                  <EmptyBlock label={selectedId && watches.data ? 'watch not found' : 'select a watch'} />
                )}
              </PanelBody>
            </Panel>
          )}
        </div>
      </div>
    </div>
  )
}
