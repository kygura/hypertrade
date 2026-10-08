import { useEffect, useState } from 'react'
import { Button } from '../Button'
import { Segmented } from '../Segmented'
import { ErrorBlock, OfflineBlock } from '../state'
import { useApi } from '../../lib/api'
import {
  advancedDiffers,
  configSummary,
  EFFORT_TRIALS,
  effortHint,
  LAB_TRANSFORMS,
  readLocal,
  TRANSFORM_LABEL,
  writeLocal,
  type FormErrors,
  type LabState,
  type MetricDef,
  type SearchForm,
} from '../../lib/lab'
import { Field, invalidStyle } from './common'
import { MetricPicker } from './MetricPicker'
import type { SearchStoreState } from './searchStore'

// LabSearchForm — DESIGN.md §10.9 (Easy mode, top → bottom, every field with
// a visible .label). Validation is inline under the field; RUN stays
// disabled while anything is invalid. While a search runs the form is
// read-only (disabled, not hidden) and RUN shows an honest elapsed counter.

const HORIZONS = [7, 14, 30, 60] as const
const ADV_KEY = 'lab.advanced'

export function LabSearchForm({
  form,
  setForm,
  errors,
  metrics,
  store,
  onRun,
  onStop,
  msPerTrial,
}: {
  form: SearchForm
  setForm: (patch: Partial<SearchForm>) => void
  errors: FormErrors
  metrics: LabState<MetricDef[]>
  store: SearchStoreState
  onRun: () => void
  onStop: () => void
  msPerTrial: number | null
}) {
  const busy = store.busy != null
  const serverField = store.error?.field ?? null
  const [touched, setTouched] = useState<Set<string>>(new Set())
  const touch = (k: string) => setTouched((s) => (s.has(k) ? s : new Set(s).add(k)))
  const err = (k: keyof SearchForm) => (touched.has(k) || serverField === k ? errors[k] : undefined)
  const bad = (k: keyof SearchForm) => serverField === k || (touched.has(k) && errors[k] != null)
  const [customHorizon, setCustomHorizon] = useState(!(HORIZONS as readonly number[]).includes(form.horizonDays))
  const invalid = Object.keys(errors).length > 0
  const canRun = !busy && !invalid && !(metrics.loading && !metrics.data)
  // ASSET datalist: the HL universe; on failure there is no list and the field stays free text.
  const universe = useApi<{ markets: { coin: string }[] }>('/hl/markets').data?.markets ?? null

  useEffect(() => {
    if (!(HORIZONS as readonly number[]).includes(form.horizonDays)) setCustomHorizon(true)
  }, [form.horizonDays])

  return (
    <form
      aria-label="search"
      className="flex flex-col gap-3 p-3"
      onSubmit={(e) => {
        e.preventDefault()
        if (canRun) onRun()
      }}
    >
      <Field label="ASSET" htmlFor="lab-asset" error={err('asset')}>
        <input
          id="lab-asset"
          list={universe ? 'lab-asset-list' : undefined}
          value={form.asset}
          disabled={busy}
          onChange={(e) => setForm({ asset: e.target.value.toUpperCase() })}
          onBlur={() => touch('asset')}
          autoComplete="off"
          spellCheck={false}
          className="w-[10ch] uppercase"
          aria-invalid={bad('asset') || undefined}
          style={invalidStyle(bad('asset'))}
        />
        {universe && (
          <datalist id="lab-asset-list">
            {universe.map((m) => (
              <option key={m.coin} value={m.coin} />
            ))}
          </datalist>
        )}
      </Field>

      <Field label="DIRECTION">
        <Segmented
          label="direction"
          options={[
            { value: 'long', label: 'LONG', tone: 'green' },
            { value: 'short', label: 'SHORT', tone: 'red' },
          ]}
          value={form.direction}
          onChange={(direction) => setForm({ direction })}
          disabled={busy}
        />
      </Field>

      <Field label="METRICS" error={err('metrics')}>
        <MetricPicker
          metrics={metrics}
          selected={form.metrics}
          asset={form.asset}
          onChange={(ids) => setForm({ metrics: ids })}
          onClose={() => touch('metrics')}
          disabled={busy}
          invalid={bad('metrics')}
        />
      </Field>

      <Field label="HORIZON" error={err('horizonDays')}>
        <div className="flex flex-wrap items-center gap-2">
          <Segmented<number | 'custom'>
            label="horizon"
            options={[...HORIZONS.map((h) => ({ value: h, label: `${h}D` })), { value: 'custom' as const, label: '…', title: 'custom horizon' }]}
            value={customHorizon ? 'custom' : form.horizonDays}
            onChange={(v) => {
              if (v === 'custom') setCustomHorizon(true)
              else {
                setCustomHorizon(false)
                setForm({ horizonDays: v })
              }
            }}
            disabled={busy}
          />
          {customHorizon && (
            <label className="flex items-center gap-1.5">
              <span className="sr-only">horizon days</span>
              <input
                type="number"
                min={1}
                max={180}
                value={Number.isFinite(form.horizonDays) ? form.horizonDays : ''}
                disabled={busy}
                onChange={(e) => setForm({ horizonDays: e.target.value === '' ? NaN : Number(e.target.value) })}
                onBlur={() => touch('horizonDays')}
                className="w-[8ch]"
                aria-invalid={bad('horizonDays') || undefined}
                style={invalidStyle(bad('horizonDays'))}
              />
              <span className="text-xs text-text-secondary">DAYS</span>
            </label>
          )}
        </div>
      </Field>

      <Field label="OBJECTIVE">
        <Segmented
          label="objective"
          options={[
            { value: 'sharpe', label: 'SHARPE' },
            { value: 'return', label: 'RETURN' },
          ]}
          value={form.objective}
          onChange={(objective) => setForm({ objective })}
          disabled={busy}
        />
      </Field>

      <Field label="EFFORT">
        <Segmented
          label="effort (trials)"
          options={EFFORT_TRIALS.map((t) => ({ value: t, label: String(t), title: `${t} trials` }))}
          value={form.trials}
          onChange={(trials) => setForm({ trials })}
          disabled={busy}
        />
        <span className="text-xs text-text-secondary tabular">{EFFORT_TRIALS.map((t) => effortHint(t, msPerTrial)).join(' · ')}</span>
      </Field>

      <AdvancedDisclosure form={form} setForm={setForm} err={err} bad={bad} touch={touch} busy={busy} />

      <div className="border-t border-border-subtle pt-3 flex flex-col gap-1.5">
        <Button tier="neutral" type="submit" disabled={!canRun} className="w-full h-[var(--control-lg)]!">
          {busy ? <span className="pulse-label">SEARCHING…</span> : 'RUN SEARCH'}
        </Button>
        {store.busy && <BusyLine startedAt={store.busy.startedAt} trials={store.busy.trials} features={store.busy.features} onStop={onStop} />}
        {store.error && !store.error.offline && <ErrorBlock message={store.error.message} />}
        {store.error?.offline && <OfflineBlock onRetry={canRun ? onRun : undefined} />}
        <p className="text-xs text-text-secondary">historical research, not advice</p>
      </div>
    </form>
  )
}

function BusyLine({ startedAt, trials, features, onStop }: { startedAt: number; trials: number; features: number; onStop: () => void }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  const s = Math.max(0, Math.floor((now - startedAt) / 1000))
  return (
    <div className="flex flex-col gap-1">
      <span className="text-sm tabular text-text-primary">
        {s} s · {trials} trials over ~{features} features
      </span>
      <div className="flex flex-wrap items-center gap-2">
        <Button tier="ghost" type="button" onClick={onStop}>
          STOP WAITING
        </Button>
        <span className="text-xs text-text-secondary">the run still finishes and lands in RUNS</span>
      </div>
    </div>
  )
}

function AdvancedDisclosure({
  form,
  setForm,
  err,
  bad,
  touch,
  busy,
}: {
  form: SearchForm
  setForm: (patch: Partial<SearchForm>) => void
  err: (k: keyof SearchForm) => string | undefined
  bad: (k: keyof SearchForm) => boolean
  touch: (k: string) => void
  busy: boolean
}) {
  const [open, setOpen] = useState(() => readLocal(ADV_KEY, { open: false }).open)
  const toggle = () => {
    setOpen(!open)
    writeLocal(ADV_KEY, { open: !open })
  }
  const differs = advancedDiffers(form)

  const num = (key: keyof SearchForm, label: string, attrs: { min?: number; max?: number; step?: number }) => (
    <Field label={label} htmlFor={`lab-${key}`} error={err(key)}>
      <input
        id={`lab-${key}`}
        type="number"
        inputMode="decimal"
        {...attrs}
        value={form[key] as string}
        disabled={busy}
        onChange={(e) => setForm({ [key]: e.target.value } as Partial<SearchForm>)}
        onBlur={() => touch(key)}
        className="w-full"
        aria-invalid={bad(key) || undefined}
        style={invalidStyle(bad(key))}
      />
    </Field>
  )

  return (
    <div className="flex flex-col gap-3">
      <button
        type="button"
        aria-expanded={open}
        aria-controls="lab-advanced"
        onClick={toggle}
        className="label self-start inline-flex items-center gap-1.5 min-h-[var(--tap-min)] hover:text-text-primary"
      >
        <span aria-hidden="true">{open ? '▾' : '▸'}</span>
        ADVANCED
        {differs && (
          <>
            <span aria-hidden="true" className="inline-block w-1.5 h-1.5 bg-amber" />
            <span className="sr-only">(changed from defaults)</span>
          </>
        )}
      </button>
      {open && (
        <div id="lab-advanced" className="flex flex-col gap-3">
          <Field label={<span id="lab-transforms-label">TRANSFORMS</span>} error={err('transforms') ?? (form.transforms.length === 0 ? 'pick at least one transform' : undefined)}>
            <div role="group" aria-labelledby="lab-transforms-label" className="flex flex-wrap gap-1">
              {LAB_TRANSFORMS.map((t) => {
                const on = form.transforms.includes(t)
                const last = on && form.transforms.length === 1
                return (
                  <label
                    key={t}
                    className={`inline-flex items-center gap-1 h-[var(--control-sm)] px-1.5 border text-xs ${on ? 'border-border bg-elevated text-text-primary' : 'border-border-subtle text-text-secondary'} ${last || busy ? 'cursor-not-allowed' : 'cursor-pointer'}`}
                    title={last ? 'at least one transform' : undefined}
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      disabled={busy || last}
                      onChange={(e) =>
                        setForm({ transforms: e.target.checked ? LAB_TRANSFORMS.filter((x) => x === t || form.transforms.includes(x)) : form.transforms.filter((x) => x !== t) })
                      }
                      className="min-h-0"
                    />
                    {TRANSFORM_LABEL[t]}
                  </label>
                )
              })}
            </div>
          </Field>
          <Field label="WINDOWS" htmlFor="lab-windows" error={err('windows')}>
            <input
              id="lab-windows"
              value={form.windows}
              disabled={busy}
              onChange={(e) => setForm({ windows: e.target.value })}
              onBlur={() => touch('windows')}
              placeholder="7, 30, 90"
              className="w-full"
              aria-invalid={bad('windows') || undefined}
              style={invalidStyle(bad('windows'))}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            {num('labelQuantile', 'LABEL QUANTILE', { min: 0.05, max: 0.5, step: 0.05 })}
            {num('folds', 'FOLDS', { min: 2, max: 6, step: 1 })}
            {num('minSupport', 'MIN SUPPORT', { min: 5, step: 1 })}
            {num('slippageBps', 'SLIPPAGE BPS', { min: 0, max: 200, step: 1 })}
            {num('topK', 'TOP K', { min: 1, max: 50, step: 1 })}
            {num('seed', 'SEED', { step: 1 })}
            <Field label="FROM" htmlFor="lab-from" error={err('from')}>
              <input
                id="lab-from"
                type="date"
                value={form.from}
                disabled={busy}
                onChange={(e) => setForm({ from: e.target.value })}
                onBlur={() => touch('from')}
                className="w-full"
                style={invalidStyle(bad('from'))}
              />
            </Field>
            <Field label="TO" htmlFor="lab-to" error={err('to')}>
              <input
                id="lab-to"
                type="date"
                value={form.to}
                disabled={busy}
                onChange={(e) => setForm({ to: e.target.value })}
                onBlur={() => touch('to')}
                className="w-full"
                style={invalidStyle(bad('to'))}
              />
            </Field>
          </div>
        </div>
      )}
    </div>
  )
}

/** Mobile: the collapsed form after a run lands — summary + EDIT. */
export function SearchSummaryBar({ form, onEdit }: { form: SearchForm; onEdit: () => void }) {
  return (
    <div className="lg:hidden sticky top-[92px] z-20 h-10 flex items-center justify-between gap-2 px-3 bg-panel-alt border border-border">
      <span className="text-xs tabular truncate">{configSummary(form)}</span>
      <Button tier="ghost" onClick={onEdit}>
        EDIT
      </Button>
    </div>
  )
}
