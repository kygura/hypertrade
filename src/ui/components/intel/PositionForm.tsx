import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { ExposurePosition, ManualPositionInput, Side } from '../../../shared/intel'
import { useApi } from '../../lib/api'
import { intel } from '../../lib/intel'
import { errorMessage } from '../../lib/poll'
import { Button } from '../Button'
import { ConfirmDialog } from '../ConfirmDialog'
import { Segmented } from '../Segmented'
import { ErrorBlock } from '../state'

// PositionForm — DESIGN-terminal §3.7. Inline below the table; edit prefills
// and scrolls into view once. Grid 4 cols lg / 2 mobile. Neutral SAVE
// (SAVING…), ghost CANCEL; edit adds Danger DELETE behind a Level 2 confirm.
// Client validation catches the obvious; a 400 renders verbatim above the
// buttons.

export interface PositionDraft {
  asset: string
  side: Side
  size: string
  entry: string
  stop: string
  leverage: string
  venue: string
}

export const EMPTY_DRAFT: PositionDraft = { asset: '', side: 'long', size: '', entry: '', stop: '', leverage: '1', venue: 'manual' }

export function draftFrom(p: ExposurePosition): PositionDraft {
  return {
    asset: p.asset,
    side: p.side,
    size: String(p.size),
    entry: String(p.entryPx),
    stop: p.stopPx != null ? String(p.stopPx) : '',
    leverage: String(p.leverage),
    venue: p.venue,
  }
}

/** Validates a draft; returns the request body or the first message to show. */
export function validatePosition(d: PositionDraft): { error: string } | { input: ManualPositionInput } {
  const asset = d.asset.trim()
  const size = Number(d.size)
  const entry = Number(d.entry)
  const lev = d.leverage.trim() === '' ? 1 : Number(d.leverage)
  const stop = d.stop.trim() === '' ? null : Number(d.stop)
  if (!asset) return { error: 'enter an asset' }
  if (!(size > 0) || !Number.isFinite(size)) return { error: 'size must be above 0' }
  if (!(entry > 0) || !Number.isFinite(entry)) return { error: 'entry must be above 0' }
  if (stop != null) {
    if (!(stop > 0) || !Number.isFinite(stop)) return { error: 'stop must be above 0' }
    if (d.side === 'long' ? stop >= entry : stop <= entry) return { error: `stop is on the wrong side of entry for a ${d.side.toUpperCase()}` }
  }
  if (!(lev >= 1 && lev <= 50)) return { error: 'leverage must be 1–50' }
  return {
    input: {
      asset,
      side: d.side,
      size,
      entryPx: entry,
      ...(stop != null ? { stopPx: stop } : {}),
      leverage: lev,
      venue: d.venue.trim() || 'manual',
    },
  }
}

const SIDES = [
  { value: 'long' as const, label: 'LONG', tone: 'green' as const },
  { value: 'short' as const, label: 'SHORT', tone: 'red' as const },
]

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 min-w-0">
      <span className="label">{label}</span>
      {children}
    </label>
  )
}

export function PositionForm({
  initial,
  onSaved,
  onCancel,
  onDeleted,
  onKeyDown,
}: {
  initial?: ExposurePosition
  onSaved: () => void
  onCancel: () => void
  onDeleted?: () => void
  onKeyDown?: (e: KeyboardEvent) => void
}) {
  const [d, setD] = useState<PositionDraft>(() => (initial ? draftFrom(initial) : EMPTY_DRAFT))
  const [invalid, setInvalid] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [delBusy, setDelBusy] = useState(false)
  const [delErr, setDelErr] = useState<string | null>(null)
  const ref = useRef<HTMLFormElement>(null)
  // HL universe for the ASSET datalist; a failure just leaves the list empty.
  const universe = useApi<{ markets: { coin: string }[] }>('/hl/markets')

  useEffect(() => {
    if (initial) ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    // once per opened edit
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial?.id])

  const set = (k: keyof PositionDraft) => (e: { target: { value: string } }) => setD((s) => ({ ...s, [k]: e.target.value }))

  const submit = async () => {
    const v = validatePosition(d)
    if ('error' in v) {
      setInvalid(v.error)
      return
    }
    setInvalid(null)
    setError(null)
    setBusy(true)
    try {
      if (initial) await intel.updatePosition(initial.id, v.input)
      else await intel.addPosition(v.input)
      onSaved()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const doDelete = async () => {
    if (!initial) return
    setDelBusy(true)
    setDelErr(null)
    try {
      await intel.deletePosition(initial.id)
      setConfirm(false)
      onDeleted?.()
    } catch (err) {
      setDelErr(errorMessage(err))
    } finally {
      setDelBusy(false)
    }
  }

  return (
    <form
      ref={ref}
      aria-label={initial ? `edit ${initial.asset} position` : 'add position'}
      className="flex flex-col gap-3 p-3 border-t border-border-subtle scroll-mt-[calc(var(--topbar-h)+var(--subnav-h)+8px)]"
      onKeyDown={confirm ? undefined : onKeyDown}
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Field label="ASSET">
          <input
            autoFocus
            value={d.asset}
            onChange={set('asset')}
            list="intel-hl-universe"
            maxLength={24}
            className="w-[8ch] min-w-full"
            autoCapitalize="characters"
            spellCheck={false}
            aria-invalid={invalid === 'enter an asset'}
          />
          <datalist id="intel-hl-universe">
            {(universe.data?.markets ?? []).map((m) => (
              <option key={m.coin} value={m.coin} />
            ))}
          </datalist>
        </Field>
        <div className="flex flex-col gap-1 min-w-0">
          <span className="label">SIDE</span>
          <Segmented label="side" options={SIDES} value={d.side} onChange={(side) => setD((s) => ({ ...s, side }))} />
        </div>
        <Field label="SIZE">
          <input type="number" inputMode="decimal" step="any" min={0} value={d.size} onChange={set('size')} aria-invalid={invalid === 'size must be above 0'} />
        </Field>
        <Field label="ENTRY">
          <input type="number" inputMode="decimal" step="any" min={0} value={d.entry} onChange={set('entry')} aria-invalid={invalid === 'entry must be above 0'} />
        </Field>
        <Field label="STOP">
          <input
            type="number"
            inputMode="decimal"
            step="any"
            min={0}
            value={d.stop}
            onChange={set('stop')}
            placeholder="optional"
            aria-invalid={invalid?.startsWith('stop') ?? false}
          />
        </Field>
        <Field label="LEVERAGE">
          <input type="number" inputMode="decimal" step="any" min={1} max={50} value={d.leverage} onChange={set('leverage')} aria-invalid={invalid?.startsWith('leverage') ?? false} />
        </Field>
        <Field label="VENUE">
          <input value={d.venue} onChange={set('venue')} maxLength={40} />
        </Field>
      </div>
      {invalid && <span className="text-[11px] text-red-text">{invalid}</span>}
      {error && <ErrorBlock message={error} />}
      <div className="flex flex-wrap gap-2">
        <Button tier="neutral" type="submit" disabled={busy}>
          <span className={busy ? 'pulse-label' : undefined}>{busy ? 'SAVING…' : 'SAVE'}</span>
        </Button>
        <Button tier="ghost" type="button" onClick={onCancel} disabled={busy}>
          CANCEL
        </Button>
        {initial && (
          <Button tier="danger" type="button" onClick={() => setConfirm(true)} disabled={busy} className="ml-auto">
            DELETE
          </Button>
        )}
      </div>
      {confirm && initial && (
        <ConfirmDialog
          title="DELETE POSITION"
          body={`Delete the manual ${initial.side.toUpperCase()} ${initial.asset} position (${initial.size} @ ${initial.entryPx})? It stops counting toward exposure and materiality.`}
          confirmLabel="DELETE POSITION"
          busy={delBusy}
          error={delErr}
          onConfirm={() => void doDelete()}
          onCancel={() => {
            setConfirm(false)
            setDelErr(null)
          }}
        />
      )}
    </form>
  )
}
