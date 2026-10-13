import { Fragment, useState } from 'react'
import { fmtUsd } from '../../../shared/format'
import type { ExposurePosition, PositionsResponse, WatchlistResponse } from '../../../shared/intel'
import { intel, type IntelState } from '../../lib/intel'
import { StatusDot } from '../Badge'
import { Button } from '../Button'
import { Panel, PanelBody, PanelHeader } from '../Panel'
import { EmptyBlock, ErrorBlock, OfflineBlock, SkeletonRows, StaleBanner } from '../state'
import { ClaimAge } from './ClaimAge'
import { isoOf, useInlineForm } from './format'
import { PositionForm } from './PositionForm'
import { PositionsTable } from './PositionsTable'
import { WatchlistEditor } from './WatchlistEditor'

// PositionsPanel (POSITIONS & WATCHLIST) — DESIGN-terminal §3.7. The page
// owns the /positions poll (60 s) and the watchlist fetch, since the review
// strip, catalysts and exposure read the same data. A failed source is never
// fatal (SPEC I0.2): it reads red with its verbatim error, the others render.

const SOURCE_LABEL = { manual: 'MANUAL', hl: 'HL', desk: 'DESK' } as const

export function PositionsPanel({
  positions,
  watchlist,
}: {
  positions: IntelState<PositionsResponse>
  watchlist: IntelState<WatchlistResponse>
}) {
  const form = useInlineForm()
  const [editing, setEditing] = useState<ExposurePosition | null>(null)
  const data = positions.data
  const fetchedIso = isoOf(positions.fetchedAt)
  const failed = data?.sources.filter((s) => !s.ok) ?? []
  const allOkEmpty = data != null && data.positions.length === 0 && failed.length === 0

  const openAdd = () => {
    setEditing(null)
    form.show()
  }
  const openEdit = (p: ExposurePosition) => {
    setEditing(p)
    form.show()
  }
  const closeForm = () => {
    setEditing(null)
    form.close()
  }
  const saved = () => {
    closeForm()
    positions.refetch()
  }

  return (
    <Panel className="h-full">
      <PanelHeader title="POSITIONS">
        {data && <span className="text-[10px] tabular text-text-primary">{fmtUsd(data.totalNotionalUsd, { compact: true })} TOTAL</span>}
        {fetchedIso && <ClaimAge ts={fetchedIso} thresholdHours={5 / 60} />}
      </PanelHeader>
      {fetchedIso && <StaleBanner generatedAt={fetchedIso} thresholdHours={0.5} noun="positions" />}
      <PanelBody>
        {positions.offline && !data ? (
          <OfflineBlock message={positions.offline} onRetry={positions.refetch} />
        ) : positions.error && !data ? (
          <ErrorBlock message={positions.error} onRetry={positions.refetch} />
        ) : !data ? (
          <SkeletonRows rows={3} />
        ) : (
          <>
            {(positions.error || positions.offline) && (
              <ErrorBlock message={positions.error ?? positions.offline ?? ''} onRetry={positions.refetch} />
            )}
            <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 px-3 py-2 text-[10px]">
              {data.sources.map((s, i) => (
                <Fragment key={s.source}>
                  {i > 0 && (
                    <span aria-hidden="true" className="text-text-secondary">
                      ·
                    </span>
                  )}
                  <span className={`inline-flex items-center gap-1 ${s.ok ? 'text-text-secondary' : 'text-red-text'}`} title={s.error}>
                    {SOURCE_LABEL[s.source]}
                    <StatusDot status={s.ok ? 'ok' : 'down'} />
                    {!s.ok && <span>✕</span>}
                    <span className="sr-only">{s.ok ? 'ok' : 'failed'}</span>
                  </span>
                </Fragment>
              ))}
            </div>
            {failed.map((s) => (
              <ErrorBlock key={s.source} message={`${SOURCE_LABEL[s.source]} — ${s.error ?? 'failed'}`} onRetry={positions.refetch} />
            ))}
            {allOkEmpty && !form.open ? (
              <EmptyBlock label="no positions — add one, or set DESK_WATCH_ADDRESS" action={{ label: 'ADD POSITION', onClick: openAdd }} />
            ) : (
              data.positions.length > 0 && <PositionsTable positions={data.positions} onEdit={openEdit} />
            )}
            {form.open ? (
              <PositionForm
                key={editing?.id ?? 'new'}
                initial={editing ?? undefined}
                onSaved={saved}
                onCancel={closeForm}
                onDeleted={saved}
                onKeyDown={form.onKeyDown}
              />
            ) : (
              !allOkEmpty && (
                <div className="px-3 py-2">
                  <Button tier="ghost" ref={form.openerRef} onClick={openAdd}>
                    + ADD POSITION
                  </Button>
                </div>
              )
            )}
          </>
        )}
        {watchlist.data ? (
          <WatchlistEditor
            items={watchlist.data.items}
            fallback={watchlist.data.fallback}
            onChange={async (items) => watchlist.setData(await intel.putWatchlist(items))}
          />
        ) : watchlist.offline || watchlist.error ? (
          <div className="border-t border-border-subtle">
            <span className="label block px-3 pt-2">WATCHLIST</span>
            <ErrorBlock message={watchlist.error ?? watchlist.offline ?? ''} onRetry={watchlist.refetch} />
          </div>
        ) : (
          <div className="border-t border-border-subtle">
            <SkeletonRows rows={1} />
          </div>
        )}
      </PanelBody>
    </Panel>
  )
}
