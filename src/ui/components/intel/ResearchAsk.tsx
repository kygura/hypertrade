import { useId, useState, type KeyboardEvent } from 'react'
import { Button } from '../Button'
import { ErrorBlock, OfflineBlock } from '../state'

// ResearchAsk — DESIGN-terminal §16.1. The §6.2 QUESTION field (one line,
// grows to 3 rows, 500 max, counter past 400), an optional ASSET input with a
// datalist of held ∪ watched (free text allowed), primary RESEARCH. Enter
// submits, Shift+Enter breaks a line. Disabled while < 3 chars or while the
// caller gives a reason (in flight, running row, 409, daily limit). Failures
// render verbatim under the box; RETRY only when offline or ≥ 500.

const WRAP_AT = 80
const MAX = 500
const COUNT_FROM = 400

export function ResearchAsk({
  assets,
  busy,
  disabledReason,
  error,
  status,
  offline,
  onSubmit,
}: {
  assets: string[]
  busy: boolean
  disabledReason: string | null
  error: string | null
  status: number | null
  offline: boolean
  onSubmit: (input: { question: string; asset?: string }, onResult?: () => void) => boolean
}) {
  const id = useId()
  const [q, setQ] = useState('')
  const [asset, setAsset] = useState('')
  const short = q.trim().length < 3
  const reason = disabledReason ?? (short ? 'type a question of at least 3 characters' : null)

  const submit = () => {
    if (reason) return
    // Cleared only once the server returned a result: a refused or failed run keeps the text for a retry.
    onSubmit({ question: q.trim(), ...(asset.trim() ? { asset: asset.trim() } : {}) }, () => {
      setQ('')
      setAsset('')
    })
  }
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }
  const retry = offline || (status != null && status >= 500) ? submit : undefined

  return (
    <div className="flex flex-col gap-2 p-3">
      <div className="flex flex-col md:flex-row md:items-start gap-2">
        <div className="flex flex-col gap-1 flex-1 min-w-0">
          <label htmlFor={`${id}-q`} className="label">
            QUESTION
          </label>
          <textarea
            id={`${id}-q`}
            value={q}
            maxLength={MAX}
            rows={q.length > WRAP_AT ? 3 : 1}
            placeholder="What explains the OI build on HYPE over 24 h?"
            aria-describedby={q.length > COUNT_FROM ? `${id}-count` : undefined}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
            className="w-full min-w-0 resize-none"
          />
          {q.length > COUNT_FROM && (
            <span id={`${id}-count`} className="text-xs text-text-secondary tabular self-end">
              {q.length} / {MAX}
            </span>
          )}
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-a`} className="label">
            ASSET
          </label>
          <input id={`${id}-a`} list={`${id}-list`} value={asset} onChange={(e) => setAsset(e.target.value)} className="w-[6ch] uppercase" />
          <datalist id={`${id}-list`}>
            {assets.map((a) => (
              <option key={a} value={a} />
            ))}
          </datalist>
        </div>
        <Button tier="neutral" onClick={submit} disabled={!!reason || busy} title={reason ?? undefined} className="flex-shrink-0 md:mt-[18px]">
          <span className={busy ? 'pulse-label' : undefined}>{busy ? 'RESEARCHING…' : 'RESEARCH'}</span>
        </Button>
      </div>
      {offline ? <OfflineBlock message={error ?? undefined} onRetry={retry} /> : error && <ErrorBlock message={error} onRetry={retry} />}
    </div>
  )
}
