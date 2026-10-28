import { useEffect, useId, useRef, useState } from 'react'
import { OrderIntentSchema, type OrderIntent, type OrderStop } from '../../../shared/intel'
import { Button } from '../Button'
import { Segmented } from '../Segmented'

// AdjustDisclosure — DESIGN-terminal §7.3. `▸ ADJUST`, collapsed by default,
// prefilled from the last preview's intent. Any edit marks the card stale
// (§7.4, via onDirty) until RE-PREVIEW posts `{intent}`. Inline red-text
// validation per field; nothing is sent while a field is invalid.

type StopKind = OrderStop['type']

export interface AdjustForm {
  asset: string
  side: 'long' | 'short'
  leverage: string
  sizeMode: 'usd' | 'pctBook'
  size: string
  entry: 'market' | 'limit'
  entryPx: string
  stop: StopKind
  stopValue: string
  target: string
}

export type AdjustErrors = Partial<Record<keyof AdjustForm, string>>

const STOP_KINDS: { value: StopKind; label: string }[] = [
  { value: 'price', label: 'price' },
  { value: 'pct', label: 'pct' },
  { value: 'prev_day_low', label: 'prev-day low' },
  { value: 'prev_day_high', label: 'prev-day high' },
  { value: 'atr_mult', label: 'ATR multiple' },
]

export function formFromIntent(i: OrderIntent): AdjustForm {
  const s = i.stop
  return {
    asset: i.asset,
    side: i.side,
    leverage: String(i.leverage),
    sizeMode: 'usd' in i.size ? 'usd' : 'pctBook',
    size: String('usd' in i.size ? i.size.usd : i.size.pctBook),
    entry: i.entry.type,
    entryPx: i.entry.type === 'limit' ? String(i.entry.px) : '',
    stop: s.type,
    stopValue: s.type === 'price' ? String(s.px) : s.type === 'pct' ? String(s.pct) : s.type === 'atr_mult' ? String(s.mult) : '',
    target: i.target != null ? String(i.target) : '',
  }
}

const num = (s: string) => (s.trim() === '' ? NaN : Number(s))

/** Form → OrderIntent, or per-field messages. The contract schema has the last word. */
export function intentFromForm(f: AdjustForm): { intent: OrderIntent; errors?: undefined } | { intent?: undefined; errors: AdjustErrors } {
  const errors: AdjustErrors = {}
  const lev = num(f.leverage)
  const size = num(f.size)
  const entryPx = num(f.entryPx)
  const stopV = num(f.stopValue)
  const target = num(f.target)
  if (!/^([A-Za-z0-9]+:)?[A-Za-z0-9]+$/.test(f.asset.trim())) errors.asset = 'enter a coin, e.g. ETH'
  if (!(lev >= 1 && lev <= 50)) errors.leverage = 'leverage 1–50'
  if (f.sizeMode === 'usd' ? !(size > 0) : !(size > 0 && size <= 100)) errors.size = f.sizeMode === 'usd' ? 'enter a positive USD size' : 'enter a % of book, 0–100'
  if (f.entry === 'limit' && !(entryPx > 0)) errors.entryPx = 'enter a limit price'
  if (f.stop === 'price' && !(stopV > 0)) errors.stopValue = 'enter a stop price'
  if (f.stop === 'pct' && !(stopV > 0 && stopV <= 50)) errors.stopValue = 'stop % 0–50'
  if (f.stop === 'atr_mult' && !(stopV > 0 && stopV <= 10)) errors.stopValue = 'ATR multiple 0–10'
  if (f.target.trim() !== '' && !(target > 0)) errors.target = 'enter a target price or leave empty'
  if (Object.keys(errors).length > 0) return { errors }

  const stop: OrderStop =
    f.stop === 'price' ? { type: 'price', px: stopV } : f.stop === 'pct' ? { type: 'pct', pct: stopV } : f.stop === 'atr_mult' ? { type: 'atr_mult', mult: stopV } : { type: f.stop }
  const candidate = {
    asset: f.asset.trim().toUpperCase(),
    side: f.side,
    leverage: lev,
    size: f.sizeMode === 'usd' ? { usd: size } : { pctBook: size },
    entry: f.entry === 'limit' ? { type: 'limit' as const, px: entryPx } : { type: 'market' as const },
    stop,
    ...(f.target.trim() !== '' ? { target } : {}),
  }
  const parsed = OrderIntentSchema.safeParse(candidate)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const key = (issue?.path[0] as keyof AdjustForm | undefined) ?? 'asset'
    return { errors: { [key]: issue?.message ?? 'invalid' } }
  }
  return { intent: parsed.data }
}

function FieldError({ id, msg }: { id: string; msg?: string }) {
  if (!msg) return null
  return (
    <span id={id} className="text-xs text-red-text">
      {msg}
    </span>
  )
}

export function AdjustDisclosure({
  intent,
  onRepreview,
  onDirty,
  busy = false,
}: {
  intent: OrderIntent
  onRepreview: (intent: OrderIntent) => void
  onDirty?: () => void
  busy?: boolean
}) {
  const uid = useId()
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState<AdjustForm>(() => formFromIntent(intent))
  const [errors, setErrors] = useState<AdjustErrors>({})
  const openerRef = useRef<HTMLButtonElement>(null)
  const firstRef = useRef<HTMLInputElement>(null)

  // A new preview re-prefills the form.
  useEffect(() => {
    setForm(formFromIntent(intent))
    setErrors({})
  }, [intent])

  useEffect(() => {
    if (open) firstRef.current?.focus()
  }, [open])

  const set = <K extends keyof AdjustForm>(k: K, v: AdjustForm[K]) => {
    setForm((f) => ({ ...f, [k]: v }))
    setErrors((e) => ({ ...e, [k]: undefined }))
    onDirty?.()
  }

  const close = () => {
    setOpen(false)
    openerRef.current?.focus()
  }

  const submit = () => {
    const r = intentFromForm(form)
    if (r.errors) {
      setErrors(r.errors)
      return
    }
    onRepreview(r.intent)
  }

  const id = (k: string) => `${uid}-${k}`
  const err = (k: keyof AdjustForm) => (errors[k] ? { 'aria-invalid': true, 'aria-describedby': id(`${k}-err`) } : {})
  const needsValue = form.stop === 'price' || form.stop === 'pct' || form.stop === 'atr_mult'

  return (
    <div className="flex flex-col gap-2">
      <button
        ref={openerRef}
        type="button"
        className="label self-start hover:text-text-primary min-h-[var(--tap-min)]"
        aria-expanded={open}
        aria-controls={id('panel')}
        onClick={() => setOpen((o) => !o)}
      >
        {open ? '▾' : '▸'} ADJUST
      </button>
      {open && (
        <div
          id={id('panel')}
          className="grid grid-cols-1 md:grid-cols-2 gap-3"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation()
              close()
            }
          }}
        >
          <div className="flex flex-col gap-1 min-w-0">
            <label htmlFor={id('asset')} className="label">
              ASSET
            </label>
            <input ref={firstRef} id={id('asset')} value={form.asset} onChange={(e) => set('asset', e.target.value)} autoCapitalize="characters" spellCheck={false} {...err('asset')} />
            <FieldError id={id('asset-err')} msg={errors.asset} />
          </div>
          <div className="flex flex-col gap-1 min-w-0">
            <span className="label">SIDE</span>
            <Segmented
              label="side"
              value={form.side}
              onChange={(v) => set('side', v)}
              options={[
                { value: 'long', label: 'LONG', tone: 'green' },
                { value: 'short', label: 'SHORT', tone: 'red' },
              ]}
            />
          </div>
          <div className="flex flex-col gap-1 min-w-0">
            <label htmlFor={id('leverage')} className="label">
              LEV
            </label>
            <input id={id('leverage')} type="number" inputMode="decimal" min={1} max={50} step="any" value={form.leverage} onChange={(e) => set('leverage', e.target.value)} {...err('leverage')} />
            <FieldError id={id('leverage-err')} msg={errors.leverage} />
          </div>
          <div className="flex flex-col gap-1 min-w-0">
            <label htmlFor={id('size')} className="label">
              SIZE
            </label>
            <div className="flex items-center gap-2">
              <input id={id('size')} className="min-w-0 flex-1" type="number" inputMode="decimal" min={0} step="any" value={form.size} onChange={(e) => set('size', e.target.value)} {...err('size')} />
              <Segmented
                label="size unit"
                value={form.sizeMode}
                onChange={(v) => set('sizeMode', v)}
                options={[
                  { value: 'usd', label: 'USD' },
                  { value: 'pctBook', label: '% BOOK' },
                ]}
              />
            </div>
            <FieldError id={id('size-err')} msg={errors.size} />
          </div>
          <div className="flex flex-col gap-1 min-w-0">
            <span className="label">ENTRY</span>
            <div className="flex items-center gap-2">
              <Segmented
                label="entry"
                value={form.entry}
                onChange={(v) => set('entry', v)}
                options={[
                  { value: 'market', label: 'MARKET' },
                  { value: 'limit', label: 'LIMIT' },
                ]}
              />
              {form.entry === 'limit' && (
                <>
                  <label htmlFor={id('entryPx')} className="sr-only">
                    limit price
                  </label>
                  <input id={id('entryPx')} className="min-w-0 flex-1" type="number" inputMode="decimal" min={0} step="any" placeholder="px" value={form.entryPx} onChange={(e) => set('entryPx', e.target.value)} {...err('entryPx')} />
                </>
              )}
            </div>
            <FieldError id={id('entryPx-err')} msg={errors.entryPx} />
          </div>
          <div className="flex flex-col gap-1 min-w-0">
            <label htmlFor={id('stop')} className="label">
              STOP
            </label>
            <div className="flex items-center gap-2">
              <select id={id('stop')} className="min-w-0 flex-1" value={form.stop} onChange={(e) => set('stop', e.target.value as StopKind)}>
                {STOP_KINDS.map((k) => (
                  <option key={k.value} value={k.value}>
                    {k.label}
                  </option>
                ))}
              </select>
              {needsValue && (
                <>
                  <label htmlFor={id('stopValue')} className="sr-only">
                    stop value
                  </label>
                  <input id={id('stopValue')} className="min-w-0 w-24" type="number" inputMode="decimal" min={0} step="any" value={form.stopValue} onChange={(e) => set('stopValue', e.target.value)} {...err('stopValue')} />
                </>
              )}
            </div>
            <FieldError id={id('stopValue-err')} msg={errors.stopValue} />
          </div>
          <div className="flex flex-col gap-1 min-w-0">
            <label htmlFor={id('target')} className="label">
              TARGET <span className="normal-case text-text-secondary">(optional)</span>
            </label>
            <input id={id('target')} type="number" inputMode="decimal" min={0} step="any" placeholder="px" value={form.target} onChange={(e) => set('target', e.target.value)} {...err('target')} />
            <FieldError id={id('target-err')} msg={errors.target} />
          </div>
          <div className="flex items-end md:col-span-2">
            <Button tier="ghost" type="button" onClick={submit} disabled={busy}>
              <span className={busy ? 'pulse-label' : undefined}>{busy ? 'PREVIEWING…' : 'RE-PREVIEW'}</span>
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
