import { useState } from 'react'
import { ConfirmDialog } from '../ConfirmDialog'
import { errorText, lab, shortId, type CatalogueEntry } from '../../lib/lab'

// REMOVE (catalogued rules) — DESIGN.md §10.9 / §7 Level 2. Cancel takes
// focus; the dialog stays open on failure with the verbatim error.

export function removeBody(e: Pick<CatalogueEntry, 'name' | 'savedAt' | 'runId'>): string {
  const since = e.savedAt.slice(0, 10)
  const again = e.runId ? `; the rule can be saved again from run ${shortId(e.runId)}.` : '.'
  return `Remove "${e.name}"? Its live record since ${since} stops here${again}`
}

export function RemoveRuleDialog({
  entry,
  onRemoved,
  onCancel,
}: {
  entry: Pick<CatalogueEntry, 'id' | 'name' | 'savedAt' | 'runId'>
  onRemoved: () => void
  onCancel: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const confirm = async () => {
    setBusy(true)
    setError(null)
    try {
      const r = await lab.remove(entry.id)
      if (!r.removed) throw new Error('rule was not in the catalogue')
      onRemoved()
    } catch (err) {
      setError(errorText(err))
      setBusy(false)
    }
  }
  return (
    <ConfirmDialog
      title="REMOVE RULE"
      body={removeBody(entry)}
      confirmLabel="REMOVE RULE"
      onConfirm={() => void confirm()}
      onCancel={onCancel}
      error={error}
      busy={busy}
    />
  )
}
