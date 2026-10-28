import { useState } from 'react'
import type { Catalyst } from '../../../shared/intel'
import { intel, type IntelState } from '../../lib/intel'
import { errorMessage } from '../../lib/poll'
import { Button } from '../Button'
import { ConfirmDialog } from '../ConfirmDialog'
import { Panel, PanelBody, PanelHeader } from '../Panel'
import { AsyncBody, EmptyBlock } from '../state'
import { ClaimAge } from './ClaimAge'
import { CatalystForm } from './CatalystForm'
import { CatalystRow } from './CatalystRow'
import { useNow } from '../../lib/hooks'
import { hoursSince, isoOf, useInlineForm } from './format'

// CatalystsPanel (CATALYSTS · 14D) — DESIGN-terminal §3.6. Rows ascending by
// scheduledAt; rows more than 1 h past are hidden. Countdowns tick each
// minute. Manual rows delete behind a Level 2 confirm. Header age = last
// successful fetch, amber when the 5-min poll has been failing > 10 min.

/** Visible rows: not more than 1 h past, soonest first. */
export function upcomingCatalysts(list: Catalyst[], now = Date.now()): Catalyst[] {
  return list
    .filter((c) => hoursSince(c.scheduledAt, now) <= 1)
    .sort((a, b) => new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime())
}

export function CatalystsPanel({ state, held, watched }: { state: IntelState<Catalyst[]>; held: Set<string>; watched: Set<string> }) {
  const now = useNow(60_000)
  const form = useInlineForm()
  const [del, setDel] = useState<Catalyst | null>(null)
  const [delBusy, setDelBusy] = useState(false)
  const [delErr, setDelErr] = useState<string | null>(null)
  const rows = state.data ? upcomingCatalysts(state.data, now) : null
  const fetchedIso = isoOf(state.fetchedAt)

  const confirmDelete = async () => {
    if (!del) return
    setDelBusy(true)
    setDelErr(null)
    try {
      await intel.deleteCatalyst(del.eventId)
      setDel(null)
      state.refetch()
    } catch (err) {
      setDelErr(errorMessage(err))
    } finally {
      setDelBusy(false)
    }
  }

  const added = () => {
    form.close()
    state.refetch()
  }

  return (
    <Panel className="h-full">
      <PanelHeader title="CATALYSTS · 14D">{fetchedIso && <ClaimAge ts={fetchedIso} thresholdHours={1 / 6} />}</PanelHeader>
      <PanelBody>
        <AsyncBody {...state} data={rows} onRetry={state.refetch}>
          {(rows) => (
          <>
            {rows.length === 0 && !form.open ? (
              <EmptyBlock label="no catalysts in the next 14 days" action={{ label: 'ADD CATALYST', onClick: form.show }} />
            ) : (
              <ol className="flex flex-col">
                {rows.map((c) => (
                  <CatalystRow
                    key={c.eventId}
                    catalyst={c}
                    held={held}
                    watched={watched}
                    now={now}
                    onDelete={c.origin === 'manual' ? () => setDel(c) : undefined}
                  />
                ))}
              </ol>
            )}
            {form.open ? (
              <CatalystForm onAdded={added} onCancel={form.close} onKeyDown={form.onKeyDown} />
            ) : (
              rows.length > 0 && (
                <div className="p-3">
                  <Button tier="ghost" ref={form.openerRef} onClick={form.show}>
                    + ADD CATALYST
                  </Button>
                </div>
              )
            )}
          </>
          )}
        </AsyncBody>
      </PanelBody>
      {del && (
        <ConfirmDialog
          title="DELETE CATALYST"
          body={`Delete "${del.title}" on ${del.scheduledAt.slice(0, 10)}? Alerts for it stop.`}
          confirmLabel="DELETE CATALYST"
          busy={delBusy}
          error={delErr}
          onConfirm={() => void confirmDelete()}
          onCancel={() => {
            setDel(null)
            setDelErr(null)
          }}
        />
      )}
    </Panel>
  )
}
