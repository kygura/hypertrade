import { useState, type KeyboardEvent } from 'react'
import { intel } from '../../lib/intel'
import { errorMessage } from '../../lib/poll'
import { Button } from '../Button'
import { ErrorBlock } from '../state'
import { commaList } from './format'

// CatalystForm — DESIGN-terminal §3.6 inline form: TITLE, WHEN (UTC)
// (datetime-local, read and submitted as UTC), ASSETS (comma list), SIZE
// optional. Neutral ADD (ADDING…), ghost CANCEL; server errors verbatim.

export interface CatalystDraft {
  title: string
  when: string
  assets: string
  size: string
}

/** `datetime-local` value (no zone) read as UTC → ISO, or null when unparseable. */
export function utcFromLocalInput(v: string): string | null {
  if (!v) return null
  const d = new Date(`${v.length === 16 ? `${v}:00` : v}Z`)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

export function validateCatalyst(d: CatalystDraft, now = Date.now()): string | null {
  const iso = utcFromLocalInput(d.when)
  if (!d.title.trim() || !iso) return 'title and time required'
  if (new Date(iso).getTime() <= now) return 'time must be in the future'
  return null
}

export function CatalystForm({ onAdded, onCancel, onKeyDown }: { onAdded: () => void; onCancel: () => void; onKeyDown?: (e: KeyboardEvent) => void }) {
  const [d, setD] = useState<CatalystDraft>({ title: '', when: '', assets: '', size: '' })
  const [invalid, setInvalid] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const set = (k: keyof CatalystDraft) => (e: { target: { value: string } }) => setD((s) => ({ ...s, [k]: e.target.value }))

  const submit = async () => {
    const v = validateCatalyst(d)
    setInvalid(v)
    if (v) return
    setBusy(true)
    setError(null)
    try {
      await intel.addCatalyst({
        title: d.title.trim(),
        scheduledAt: utcFromLocalInput(d.when)!,
        assets: commaList(d.assets),
        ...(d.size.trim() ? { size: d.size.trim() } : {}),
      })
      onAdded()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className="flex flex-col gap-2 p-3 border-t border-border-subtle"
      onKeyDown={onKeyDown}
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <label className="flex flex-col gap-1">
        <span className="label">TITLE</span>
        <input autoFocus value={d.title} onChange={set('title')} maxLength={200} aria-invalid={invalid === 'title and time required' && !d.title.trim()} />
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-1 min-w-0">
          <span className="label">WHEN (UTC)</span>
          <input type="datetime-local" value={d.when} onChange={set('when')} aria-invalid={invalid != null && (invalid === 'time must be in the future' || !utcFromLocalInput(d.when))} />
        </label>
        <label className="flex flex-col gap-1 min-w-0">
          <span className="label">ASSETS</span>
          <input value={d.assets} onChange={set('assets')} placeholder="BTC, ETH" autoCapitalize="characters" spellCheck={false} />
        </label>
      </div>
      <label className="flex flex-col gap-1">
        <span className="label">SIZE</span>
        <input value={d.size} onChange={set('size')} maxLength={120} placeholder="optional" />
      </label>
      {invalid && <span className="text-sm text-red-text">{invalid}</span>}
      {error && <ErrorBlock message={error} />}
      <div className="flex gap-2">
        <Button tier="neutral" type="submit" disabled={busy}>
          <span className={busy ? 'pulse-label' : undefined}>{busy ? 'ADDING…' : 'ADD'}</span>
        </Button>
        <Button tier="ghost" type="button" onClick={onCancel} disabled={busy}>
          CANCEL
        </Button>
      </div>
    </form>
  )
}
