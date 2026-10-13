import { useCallback, useMemo, useState } from 'react'
import type { Watch } from '../../../shared/intel'
import { Button } from '../Button'
import { ConfirmDialog } from '../ConfirmDialog'
import { Panel, PanelBody, PanelHeader } from '../Panel'
import { EmptyBlock, ErrorBlock, OfflineBlock, SkeletonRows } from '../state'
import { fmtTs } from '../strategy/format'
import { intel, useIntel } from '../../lib/intel'
import { errorMessage } from '../../lib/poll'
import { ChangeEntry } from './ChangeEntry'
import { ClaimAge } from './ClaimAge'
import { KIND_LABEL } from './watch'

// WatchChanges — DESIGN-terminal §8.2. The selected watch: Neutral CHECK NOW
// (`POST /watches/:id/check`, `CHECKING…`), Danger DELETE (Level 2), the meta
// line (kind, full target, asset, last checked, error), then one ChangeEntry
// per change, newest first.

export function WatchChanges({ watch, onChecked, onDeleted }: { watch: Watch; onChecked: () => void; onDeleted: () => void }) {
  const changes = useIntel(() => intel.watchChanges(watch.id), [watch.id])
  const [checking, setChecking] = useState(false)
  const [checkError, setCheckError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const sorted = useMemo(() => [...(changes.data ?? [])].sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts)), [changes.data])
  const name = watch.label || watch.target

  const check = async () => {
    if (checking) return
    setChecking(true)
    setCheckError(null)
    try {
      await intel.checkWatch(watch.id)
      changes.refetch()
      onChecked()
    } catch (err) {
      setCheckError(errorMessage(err, 'check failed'))
    } finally {
      setChecking(false)
    }
  }

  const remove = async () => {
    if (deleting) return
    setDeleting(true)
    setDeleteError(null)
    try {
      await intel.deleteWatch(watch.id)
      setConfirmDelete(false)
      onDeleted()
    } catch (err) {
      setDeleteError(errorMessage(err, 'delete failed'))
    } finally {
      setDeleting(false)
    }
  }

  const cancelDelete = useCallback(() => {
    setConfirmDelete(false)
    setDeleteError(null)
  }, [])

  return (
    <Panel>
      <PanelHeader title={`CHANGES · ${name}`} className="min-w-0" />
      <PanelBody className="p-3 flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <Button tier="neutral" onClick={() => void check()} disabled={checking}>
            <span className={checking ? 'pulse-label' : undefined}>{checking ? 'CHECKING…' : 'CHECK NOW'}</span>
          </Button>
          <Button tier="danger" onClick={() => setConfirmDelete(true)}>
            DELETE
          </Button>
        </div>
        {checkError && <ErrorBlock message={checkError} />}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-text-secondary">
          <span>{KIND_LABEL[watch.kind]}</span>
          {watch.kind === 'url' && /^https:\/\//i.test(watch.target) ? (
            <a href={watch.target} target="_blank" rel="noopener noreferrer" className="text-text-primary break-all hover:underline">
              {watch.target} <span aria-hidden="true">↗</span>
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          ) : (
            <span className="text-text-primary break-all tabular">
              {watch.target}
              {watch.chain ? ` · ${watch.chain}` : ''}
            </span>
          )}
          {watch.asset && <span className="src-tag">{watch.asset}</span>}
        </div>
        <div className="text-[10px] tabular text-text-secondary">
          {watch.checkedAt ? (
            <>
              checked {fmtTs(watch.checkedAt)} · <ClaimAge ts={watch.checkedAt} thresholdHours={2} />
            </>
          ) : (
            'not checked yet'
          )}
        </div>
        {watch.error && <ErrorBlock message={watch.error} />}
        <div>
          {changes.loading && !changes.data ? (
            <SkeletonRows rows={3} />
          ) : changes.offline && !changes.data ? (
            <OfflineBlock message={changes.offline} onRetry={changes.refetch} />
          ) : changes.error && !changes.data ? (
            <ErrorBlock message={changes.error} onRetry={changes.refetch} />
          ) : sorted.length === 0 ? (
            <EmptyBlock label={`no changes since ${fmtTs(watch.createdAt)}`} />
          ) : (
            sorted.map((c) => <ChangeEntry key={c.id} change={c} />)
          )}
        </div>
      </PanelBody>
      {confirmDelete && (
        <ConfirmDialog
          title="DELETE WATCH"
          body={`Stop watching ${name}? Its change history goes with it.`}
          confirmLabel="DELETE WATCH"
          onConfirm={() => void remove()}
          onCancel={cancelDelete}
          error={deleteError}
          busy={deleting}
        />
      )}
    </Panel>
  )
}
