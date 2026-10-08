import { forwardRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { Badge } from '../Badge'
import { Button } from '../Button'
import { ErrorBlock } from '../state'
import { errorText, lab, type CatalogueEntry, type Rule } from '../../lib/lab'

// SaveToCatalogueForm — DESIGN.md §10.9. Inline panel (Level 1): NAME
// (default: the rule text cut to 40ch), NOTE, SAVE TO CATALOGUE. Once saved
// the panel becomes the IN CATALOGUE stamp + OPEN CATALOGUE →.

export const SaveToCatalogueForm = forwardRef<
  HTMLInputElement,
  {
    rule: Rule
    runId: string | null
    defaultName: string
    entry: Pick<CatalogueEntry, 'savedAt'> | null
    onSaved: (e: CatalogueEntry) => void
  }
>(function SaveToCatalogueForm({ rule, runId, defaultName, entry, onSaved }, ref) {
  const navigate = useNavigate()
  const [name, setName] = useState(defaultName)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (entry) {
    return (
      <div className="flex flex-wrap items-center gap-2 p-3">
        <Badge tone="info">IN CATALOGUE · SAVED {entry.savedAt.slice(0, 10)}</Badge>
        <Button tier="ghost" onClick={() => navigate('/lab/catalogue')}>
          OPEN CATALOGUE →
        </Button>
      </div>
    )
  }

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      const saved = await lab.save({ rule, name: name.trim(), ...(note.trim() ? { note: note.trim() } : {}), ...(runId ? { runId } : {}) })
      onSaved(saved)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className="flex flex-col gap-3 p-3"
      onSubmit={(e) => {
        e.preventDefault()
        if (name.trim() && !busy) void save()
      }}
    >
      <label className="flex flex-col gap-1">
        <span className="label">NAME</span>
        <input ref={ref} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} disabled={busy} className="w-full" />
        {!name.trim() && <span className="text-sm text-red-text">name the rule</span>}
      </label>
      <label className="flex flex-col gap-1">
        <span className="label">NOTE</span>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} disabled={busy} className="w-full resize-y" />
      </label>
      <Button tier="neutral" type="submit" disabled={busy || !name.trim()} className="w-full">
        {busy ? <span className="pulse-label">SAVING…</span> : 'SAVE TO CATALOGUE'}
      </Button>
      {error && <ErrorBlock message={error} />}
    </form>
  )
})
