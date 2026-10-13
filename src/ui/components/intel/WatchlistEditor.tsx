import { useState } from 'react'
import type { WatchlistItem } from '../../../shared/intel'
import { errorMessage } from '../../lib/poll'
import { Badge } from '../Badge'
import { Button } from '../Button'
import { ErrorBlock } from '../state'
import { commaList, useInlineForm } from './format'

// WatchlistEditor — DESIGN-terminal §3.7. Chips of coin + tag chips + ✕
// (Level 1, no confirm); + ADD opens a one-row form (ASSET, TAGS, ADD). Every
// write is a full PUT (the caller's onChange). Fallback (DESK_WATCHLIST in
// use because the stored list is empty): gray FALLBACK badge, chips without ✕;
// adding an asset starts the operator's own list.

export function WatchlistEditor({
  items,
  fallback,
  onChange,
}: {
  items: WatchlistItem[]
  fallback: boolean
  onChange: (items: WatchlistItem[]) => Promise<void>
}) {
  const form = useInlineForm()
  const [asset, setAsset] = useState('')
  const [tags, setTags] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const write = async (next: WatchlistItem[]): Promise<boolean> => {
    setBusy(true)
    setError(null)
    try {
      await onChange(next)
      return true
    } catch (err) {
      setError(errorMessage(err))
      return false
    } finally {
      setBusy(false)
    }
  }

  const add = async () => {
    const a = asset.trim()
    if (!a) return
    const base = fallback ? [] : items
    if (await write([...base.filter((i) => i.asset !== a), { asset: a, tags: commaList(tags) }])) {
      setAsset('')
      setTags('')
      form.close()
    }
  }

  return (
    <div className="flex flex-col gap-2 p-3 border-t border-border-subtle">
      <div className="flex flex-wrap items-center gap-2">
        <span className="label">WATCHLIST · {items.length}</span>
        {fallback && (
          <>
            <Badge tone="gray">FALLBACK</Badge>
            <span className="text-[10px] text-text-secondary">empty — using DESK_WATCHLIST</span>
          </>
        )}
      </div>
      <ul className="flex flex-wrap items-center gap-1.5">
        {items.map((i) => (
          <li key={i.asset} className="inline-flex items-center gap-1 border border-border-subtle pl-1.5 text-[11px] text-text-primary">
            <span className="py-0.5">{i.asset}</span>
            {i.tags.map((t) => (
              <span key={t} className="text-[9px] text-text-secondary">
                [{t}]
              </span>
            ))}
            {fallback ? (
              <span className="pr-1.5" />
            ) : (
              <button
                type="button"
                aria-label={`remove ${i.asset} from watchlist`}
                disabled={busy}
                onClick={() => void write(items.filter((x) => x.asset !== i.asset))}
                className="min-w-[var(--tap-min)] min-h-[var(--tap-min)] px-1 text-text-secondary hover:text-text-primary disabled:text-text-disabled"
              >
                ✕
              </button>
            )}
          </li>
        ))}
        {!form.open && (
          <li>
            <Button tier="ghost" ref={form.openerRef} onClick={form.show}>
              + ADD
            </Button>
          </li>
        )}
      </ul>
      {form.open && (
        <form
          className="flex flex-wrap items-end gap-2"
          onKeyDown={form.onKeyDown}
          onSubmit={(e) => {
            e.preventDefault()
            void add()
          }}
        >
          <label className="flex flex-col gap-1">
            <span className="label">ASSET</span>
            <input autoFocus value={asset} onChange={(e) => setAsset(e.target.value)} className="w-[10ch]" maxLength={24} autoCapitalize="characters" spellCheck={false} />
          </label>
          <label className="flex flex-col gap-1 flex-1 min-w-[12ch]">
            <span className="label">TAGS</span>
            <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="l1, defi" />
          </label>
          <Button tier="neutral" type="submit" disabled={busy || !asset.trim()}>
            <span className={busy ? 'pulse-label' : undefined}>{busy ? 'ADDING…' : 'ADD'}</span>
          </Button>
          <Button tier="ghost" type="button" onClick={form.close} disabled={busy}>
            CANCEL
          </Button>
        </form>
      )}
      {error && <ErrorBlock message={error} />}
    </div>
  )
}
