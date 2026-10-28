import { useEffect, useId, useRef, useState } from 'react'
import { CHAINS, type Watch } from '../../../shared/intel'
import { Button } from '../Button'
import { Segmented } from '../Segmented'
import { ErrorBlock } from '../state'
import { intel } from '../../lib/intel'
import { errorMessage } from '../../lib/poll'
import { validateWatchForm, type WatchFormErrors, type WatchFormValues, type WatchKind } from './watch'

// WatchForm — DESIGN-terminal §8.2. Inline under `+ ADD WATCH`: KIND
// Segmented, TARGET, CHAIN (not for URL), ASSET (required), LABEL
// (optional); Neutral ADD, Level 1 (DESIGN §7): one click, verbatim
// ErrorBlock on failure. Client validation before any request. First field
// focused on open; Esc cancels (the page refocuses the opener).

const KINDS = [
  { value: 'url' as const, label: 'URL' },
  { value: 'evm_contract' as const, label: 'CONTRACT' },
  { value: 'evm_wallet' as const, label: 'WALLET' },
]

export const EMPTY_WATCH_FORM: WatchFormValues = { kind: 'url', target: '', chain: 'ethereum', asset: '', label: '' }

export function WatchForm({ onAdded, onCancel, initial = EMPTY_WATCH_FORM }: { onAdded: (w: Watch) => void; onCancel: () => void; initial?: WatchFormValues }) {
  const uid = useId()
  const [v, setV] = useState<WatchFormValues>(initial)
  const [errors, setErrors] = useState<WatchFormErrors>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const firstRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    firstRef.current?.focus()
  }, [])

  const set = <K extends keyof WatchFormValues>(k: K, val: WatchFormValues[K]) => {
    setV((s) => ({ ...s, [k]: val }))
    setErrors((e) => ({ ...e, [k]: undefined }))
  }

  const submit = async () => {
    if (busy) return
    const r = validateWatchForm(v)
    if (r.errors) {
      setErrors(r.errors)
      return
    }
    setBusy(true)
    setError(null)
    try {
      const w = await intel.addWatch(r.input)
      onAdded(w)
    } catch (err) {
      setError(errorMessage(err, 'add failed'))
    } finally {
      setBusy(false)
    }
  }

  const id = (k: string) => `${uid}-${k}`
  const err = (k: keyof WatchFormValues) => (errors[k] ? { 'aria-invalid': true, 'aria-describedby': id(`${k}-err`) } : {})
  const msg = (k: keyof WatchFormValues) =>
    errors[k] ? (
      <span id={id(`${k}-err`)} className="text-xs text-red-text">
        {errors[k]}
      </span>
    ) : null

  return (
    <form
      aria-label="add watch"
      className="flex flex-col gap-3 p-3 border-t border-border-subtle"
      noValidate
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          onCancel()
        }
      }}
    >
      <div className="flex flex-col gap-1">
        <span className="label">KIND</span>
        <Segmented<WatchKind> label="watch kind" value={v.kind} onChange={(k) => set('kind', k)} options={KINDS} />
      </div>
      <div className="flex flex-col gap-1 min-w-0">
        <label htmlFor={id('target')} className="label">
          TARGET
        </label>
        <input
          ref={firstRef}
          id={id('target')}
          className="w-full"
          value={v.target}
          onChange={(e) => set('target', e.target.value)}
          placeholder={v.kind === 'url' ? 'https://docs.example.com/fees' : '0x…'}
          spellCheck={false}
          autoComplete="off"
          inputMode={v.kind === 'url' ? 'url' : 'text'}
          {...err('target')}
        />
        {msg('target')}
        {v.kind === 'url' && <span className="text-xs text-text-secondary">JS-rendered or bot-blocked pages fail visibly</span>}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {v.kind !== 'url' && (
          <div className="flex flex-col gap-1 min-w-0">
            <label htmlFor={id('chain')} className="label">
              CHAIN
            </label>
            <select id={id('chain')} className="w-full" value={v.chain} onChange={(e) => set('chain', e.target.value as WatchFormValues['chain'])} {...err('chain')}>
              {CHAINS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            {msg('chain')}
          </div>
        )}
        <div className="flex flex-col gap-1 min-w-0">
          <label htmlFor={id('asset')} className="label">
            ASSET
          </label>
          <input id={id('asset')} className="w-full" value={v.asset} onChange={(e) => set('asset', e.target.value)} autoCapitalize="characters" spellCheck={false} {...err('asset')} />
          {msg('asset')}
        </div>
        <div className="flex flex-col gap-1 min-w-0">
          <label htmlFor={id('label')} className="label">
            LABEL <span className="normal-case text-text-secondary">(optional)</span>
          </label>
          <input id={id('label')} className="w-full" value={v.label} maxLength={80} onChange={(e) => set('label', e.target.value)} {...err('label')} />
          {msg('label')}
        </div>
      </div>
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
