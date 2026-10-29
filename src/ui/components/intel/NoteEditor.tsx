import { useEffect, useId, useState } from 'react'
import type { TradeNote } from '../../../shared/intel'
import { intel } from '../../lib/intel'
import { Button } from '../Button'
import { ErrorBlock } from '../state'
import { useAction } from './useAction'

// NoteEditor — DESIGN-terminal §4.2. The operator's own note on a trade:
// textarea (3 rows, ≤ 280 chars, counter), Neutral `SAVE NOTE` (PUT
// /journal/:tradeId/note, Level 1, `SAVING…`), then `SAVED ✓` for 3 s. An
// empty note clears it. Failure → verbatim ErrorBlock under the button.
// Remount per trade (`key={trade.id}`) so a draft never leaks across rows.

export const NOTE_MAX = 280
export const SAVED_MS = 3000

type SaveFn = (tradeId: string, note: string) => Promise<TradeNote>

/** Trim and send; the outcome the editor renders. Pure apart from `save`. */
export async function submitNote(
  save: SaveFn,
  tradeId: string,
  draft: string,
): Promise<{ ok: true; note: TradeNote } | { ok: false; error: string }> {
  const text = draft.trim().slice(0, NOTE_MAX)
  try {
    return { ok: true, note: await save(tradeId, text) }
  } catch (err) {
    return { ok: false, error: err instanceof Error && err.message ? err.message : 'save failed' }
  }
}

export function NoteEditor({
  tradeId,
  note,
  onSaved,
  save = intel.saveNote,
}: {
  tradeId: string
  note: string | null
  onSaved: (note: TradeNote) => void
  save?: SaveFn
}) {
  const id = useId()
  const [draft, setDraft] = useState(note ?? '')
  const [saved, setSaved] = useState(false)
  const action = useAction(async (text: string) => {
    const r = await submitNote(save, tradeId, text)
    if (!r.ok) throw new Error(r.error)
    return r.note
  })

  useEffect(() => {
    if (!saved) return
    const t = setTimeout(() => setSaved(false), SAVED_MS)
    return () => clearTimeout(t)
  }, [saved])

  const dirty = draft.trim() !== (note ?? '').trim()

  const onSave = async () => {
    const n = await action.run(draft)
    if (n) {
      setSaved(true)
      onSaved(n)
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="label">
        NOTE
      </label>
      <textarea
        id={id}
        rows={3}
        maxLength={NOTE_MAX}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value)
          setSaved(false)
        }}
        disabled={action.busy}
        className="w-full resize-y"
        aria-describedby={`${id}-count`}
      />
      <div className="flex items-center justify-between gap-2">
        <span id={`${id}-count`} className="text-xs tabular text-text-secondary">
          {draft.length}/{NOTE_MAX}
        </span>
        <Button tier="neutral" onClick={() => void onSave()} disabled={action.busy || (!dirty && !action.error)}>
          <span className={action.busy ? 'pulse-label' : undefined}>{action.busy ? 'SAVING…' : saved ? 'SAVED ✓' : 'SAVE NOTE'}</span>
        </Button>
      </div>
      {action.error && <ErrorBlock message={action.error} onRetry={() => void onSave()} />}
    </div>
  )
}
