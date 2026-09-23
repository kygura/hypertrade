import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router'
import { Badge, Button, ErrorBlock, SkeletonRows } from '../components'
import { engine, errorMessage, useEngine } from '../lib/engine'
import { ApiError } from '../lib/api'
import type { DecisionRecord, GovernorMode, GovernorOverride, StrategyConfig, StrategyStatus } from '../../shared/strategy-protocol'
import { defaultParams, validateParams, type ParamValues } from '../../shared/strategy-params'
import { EngineTabs } from '../components/strategy/EngineTabs'
import { EngineOffline, OfflineStrip } from '../components/strategy/EngineOffline'
import { ParamForm } from '../components/strategy/ParamForm'
import { DecisionMeta, DecisionView } from '../components/strategy/DecisionView'
import { fmtAge, fmtTs } from '../components/strategy/format'

// /strategies/:id — manifest description, param form generated from
// manifest.params (min/max/step/enum validated client-side, mirrored by
// the core's 400 {error, field}), per-strategy governor override, SAVE
// (PUT config) and DRY RUN (POST run {dry_run:true}) whose DecisionRecord
// renders inline beneath. Desktop: config 5 cols / result 7 cols; mobile:
// config first (this page is the editor), result beneath.

type Busy = 'idle' | 'saving' | 'running'

const MODES: { value: GovernorMode | ''; label: string }[] = [
  { value: '', label: 'INHERIT' },
  { value: 'manual', label: 'MANUAL' },
  { value: 'threshold', label: 'THRESHOLD' },
  { value: 'auto', label: 'AUTO' },
]

interface OverrideForm {
  mode: GovernorMode | ''
  min_confidence: string
  max_notional_usd: string
  max_open_intents: string
}

function overrideToForm(g: GovernorOverride | undefined): OverrideForm {
  return {
    mode: g?.mode ?? '',
    min_confidence: g?.min_confidence != null ? String(g.min_confidence) : '',
    max_notional_usd: g?.max_notional_usd != null ? String(g.max_notional_usd) : '',
    max_open_intents: g?.max_open_intents != null ? String(g.max_open_intents) : '',
  }
}

function formToOverride(f: OverrideForm, existing: GovernorOverride | undefined): GovernorOverride | undefined {
  const out: GovernorOverride = {}
  if (f.mode) out.mode = f.mode
  if (f.min_confidence.trim() !== '') out.min_confidence = Number(f.min_confidence)
  if (f.max_notional_usd.trim() !== '') out.max_notional_usd = Number(f.max_notional_usd)
  if (f.max_open_intents.trim() !== '') out.max_open_intents = Number(f.max_open_intents)
  if (existing?.killed != null) out.killed = existing.killed
  return Object.keys(out).length > 0 ? out : undefined
}

function overrideErrors(f: OverrideForm): Record<string, string> {
  const e: Record<string, string> = {}
  const num = (s: string) => (s.trim() === '' ? null : Number(s))
  const mc = num(f.min_confidence)
  if (mc != null && (Number.isNaN(mc) || mc < 0 || mc > 1)) e.min_confidence = 'must be between 0 and 1'
  const mn = num(f.max_notional_usd)
  if (mn != null && (Number.isNaN(mn) || mn < 0)) e.max_notional_usd = 'must be ≥ 0'
  const mo = num(f.max_open_intents)
  if (mo != null && (Number.isNaN(mo) || mo < 0 || !Number.isInteger(mo))) e.max_open_intents = 'must be a whole number ≥ 0'
  return e
}

export function StrategyDetail() {
  const { id } = useParams<{ id: string }>()
  const status = useEngine(() => engine.getStrategy(id!), [id], { enabled: !!id })

  const [enabled, setEnabled] = useState(false)
  const [venue, setVenue] = useState('')
  const [params, setParams] = useState<ParamValues | null>(null)
  const [override, setOverride] = useState<OverrideForm>(overrideToForm(undefined))
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState<Busy>('idle')
  const [saveError, setSaveError] = useState<{ message: string; field?: string } | null>(null)
  const [runError, setRunError] = useState<string | null>(null)
  const [dryRun, setDryRun] = useState<DecisionRecord | null>(null)

  // Seed the form once from the first status; later polls must not clobber
  // in-progress edits (the amber dirty dot tells the operator they differ).
  useEffect(() => {
    if (status.data && params === null) seed(status.data)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.data])

  function seed(s: StrategyStatus) {
    setEnabled(s.config.enabled)
    setVenue(s.config.venue)
    setParams({ ...defaultParams(s.manifest.params), ...s.config.params })
    setOverride(overrideToForm(s.config.governor))
    setDirty(false)
  }

  if (!id) return null

  const manifest = status.data?.manifest
  const paramErrors = manifest && params ? validateParams(manifest.params, params) : {}
  const govErrors = overrideErrors(override)
  const valid = Object.keys(paramErrors).length === 0 && Object.keys(govErrors).length === 0

  function candidate(): StrategyConfig | null {
    if (!status.data || !params) return null
    return {
      id: status.data.config.id,
      enabled,
      venue,
      params,
      governor: formToOverride(override, status.data.config.governor),
    }
  }

  async function save() {
    const config = candidate()
    if (!config || !valid || busy !== 'idle') return
    setBusy('saving')
    setSaveError(null)
    try {
      const updated = await engine.putConfig(config.id, config)
      status.setData(updated)
      seed(updated)
    } catch (err) {
      // The core's 400 carries {error, field: "params.size_usd"}; the message
      // renders under that param's input, otherwise as a block by the buttons.
      const field = err instanceof ApiError ? err.field?.replace(/^params\./, '') : undefined
      setSaveError({ message: errorMessage(err, 'save failed'), field })
    } finally {
      setBusy('idle')
    }
  }

  async function runDry() {
    if (!status.data || busy !== 'idle') return
    setBusy('running')
    setRunError(null)
    try {
      setDryRun(await engine.run(status.data.config.id, true))
    } catch (err) {
      setRunError(errorMessage(err, 'dry run failed'))
    } finally {
      setBusy('idle')
    }
  }

  const { data, loading, error, offline, fetchedAt, refetch } = status
  const fieldErrors = { ...paramErrors }
  if (saveError?.field && !fieldErrors[saveError.field]) fieldErrors[saveError.field] = saveError.message

  return (
    <div className="max-w-[1440px] mx-auto p-3 md:p-[var(--gutter)]">
      <EngineTabs />
      <div className="flex items-center gap-2 mb-3 text-[10px] uppercase tracking-wider">
        <Link to="/strategies" className="text-text-secondary hover:text-text-primary">
          ← STRATEGIES
        </Link>
        <span className="text-text-secondary">/</span>
        <span className="text-text-primary">{id}</span>
      </div>

      {loading && !data && (
        <div className="panel">
          <div className="panel-body">
            <SkeletonRows rows={5} />
          </div>
        </div>
      )}
      {!loading && offline && !data && (
        <div className="panel">
          <div className="panel-body">
            <EngineOffline reason={offline} onRetry={refetch} />
          </div>
        </div>
      )}
      {!loading && !offline && error && !data && (
        <div className="panel">
          <div className="panel-body">
            <ErrorBlock message={error} onRetry={refetch} />
          </div>
        </div>
      )}

      {data && manifest && params && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-3">
          {/* CONFIG */}
          <div className="lg:col-span-5 panel">
            {offline && <OfflineStrip reason={offline} fetchedAt={fetchedAt} />}
            <div className="panel-header">
              <span className="flex items-center gap-1.5">
                <span className="panel-title">CONFIG</span>
                {dirty && <span className="inline-block w-1.5 h-1.5 bg-amber" title="unsaved changes" />}
              </span>
              <span className="text-[10px] text-text-secondary tabular" title={fmtTs(data.last_run_at)}>
                LAST RUN {fmtAge(data.last_run_at)}
              </span>
            </div>
            <div className="panel-body p-3 flex flex-col gap-3">
              <div className="flex flex-col gap-1">
                <span className="text-[16px] text-text-primary">{manifest.name}</span>
                <span className="text-[10px] text-text-secondary tabular">
                  v{manifest.version} · {manifest.cadence || '—'} · {manifest.markets.join(', ') || 'no default markets'}
                </span>
                <p className="text-[13px] text-text-muted">{manifest.description || 'no description'}</p>
                {data.last_error && <ErrorBlock message={data.last_error} />}
              </div>

              <div className="grid grid-cols-2 gap-3 pt-2 border-t border-border-subtle">
                <div className="flex flex-col gap-1">
                  <span className="label">ENABLED</span>
                  <div role="radiogroup" aria-label="enabled" className="flex gap-1.5">
                    {[true, false].map((opt) => (
                      <button
                        key={String(opt)}
                        type="button"
                        role="radio"
                        aria-checked={enabled === opt}
                        onClick={() => {
                          setEnabled(opt)
                          setDirty(true)
                        }}
                        className={`h-[var(--control-md)] px-3 text-[10px] font-mono uppercase border border-border ${
                          enabled === opt ? (opt ? 'text-green bg-green-bg' : 'text-text-primary bg-selected') : 'text-text-secondary'
                        }`}
                      >
                        {opt ? 'ON' : 'OFF'}
                      </button>
                    ))}
                  </div>
                </div>
                <label className="flex flex-col gap-1">
                  <span className="label">VENUE</span>
                  <select
                    value={venue}
                    onChange={(e) => {
                      setVenue(e.target.value)
                      setDirty(true)
                    }}
                    className="w-full"
                  >
                    {(manifest.venues.includes(venue) ? manifest.venues : [venue, ...manifest.venues]).map((v) => (
                      <option key={v} value={v}>
                        {v}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <div className="flex flex-col gap-2 pt-2 border-t border-border-subtle">
                <span className="label">PARAMS</span>
                <ParamForm
                  specs={manifest.params}
                  values={params}
                  errors={fieldErrors}
                  disabled={busy === 'saving'}
                  onChange={(key, value) => {
                    setParams((p) => ({ ...(p ?? {}), [key]: value }))
                    setDirty(true)
                  }}
                />
              </div>

              <div className="flex flex-col gap-2 pt-2 border-t border-border-subtle">
                <div className="flex items-center justify-between">
                  <span className="label">GOVERNOR OVERRIDE</span>
                  <Link to="/governor" className="text-[10px] uppercase tracking-wider text-text-secondary hover:text-text-primary">
                    GLOBAL →
                  </Link>
                </div>
                <span className="text-[10px] text-text-secondary">blank fields inherit the global governor</span>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div className="flex flex-col gap-1">
                    <span className="label">MODE</span>
                    <div className="flex flex-wrap gap-1.5">
                      {MODES.map((m) => (
                        <button
                          key={m.value}
                          type="button"
                          onClick={() => {
                            setOverride((o) => ({ ...o, mode: m.value }))
                            setDirty(true)
                          }}
                          className={`h-[var(--control-sm)] px-2 text-[10px] font-mono uppercase border border-border ${
                            override.mode === m.value ? 'text-text-primary bg-selected' : 'text-text-secondary'
                          }`}
                        >
                          {m.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  {(
                    [
                      ['min_confidence', 'MIN CONFIDENCE', '0', '1', '0.01'],
                      ['max_notional_usd', 'MAX NOTIONAL (USD)', '0', undefined, '1'],
                      ['max_open_intents', 'MAX OPEN INTENTS', '0', undefined, '1'],
                    ] as const
                  ).map(([key, label, min, max, step]) => (
                    <label key={key} className="flex flex-col gap-1">
                      <span className="label">{label}</span>
                      <input
                        type="number"
                        inputMode="decimal"
                        min={min}
                        max={max}
                        step={step}
                        placeholder="inherit"
                        value={override[key]}
                        aria-invalid={!!govErrors[key]}
                        onChange={(e) => {
                          const v = e.target.value
                          setOverride((o) => ({ ...o, [key]: v }))
                          setDirty(true)
                        }}
                        className="w-full"
                      />
                      {govErrors[key] && (
                        <span role="alert" className="text-[10px] text-red-text">
                          {govErrors[key]}
                        </span>
                      )}
                    </label>
                  ))}
                </div>
              </div>

              {saveError && !saveError.field && <ErrorBlock message={saveError.message} />}

              <div className="flex gap-2 pt-2 border-t border-border-subtle">
                <Button tier="neutral" className="flex-1" onClick={save} disabled={!valid || busy !== 'idle'}>
                  <span className={busy === 'saving' ? 'pulse-label' : undefined}>{busy === 'saving' ? 'SAVING…' : 'SAVE'}</span>
                </Button>
                <Button tier="ghost" className="flex-1" onClick={runDry} disabled={busy !== 'idle'}>
                  <span className={busy === 'running' ? 'pulse-label' : undefined}>{busy === 'running' ? 'RUNNING…' : 'DRY RUN'}</span>
                </Button>
              </div>
              <span className="text-[10px] text-text-secondary">
                dry run uses the saved config — it never touches a venue or the governor
              </span>
              {dirty && <span className="text-[10px] text-amber">unsaved changes are not used by DRY RUN until saved</span>}
            </div>
          </div>

          {/* DRY RUN RESULT */}
          <div className="lg:col-span-7 flex flex-col gap-3">
            <div className="panel">
              <div className="panel-header">
                <span className="panel-title">DRY RUN</span>
                {dryRun && <Badge tone="info">DRY RUN</Badge>}
              </div>
              <div className="panel-body p-3 flex flex-col gap-3">
                {runError && <ErrorBlock message={runError} onRetry={runDry} />}
                {!dryRun && busy !== 'running' && !runError && (
                  <div className="flex flex-col items-center gap-2 py-8 text-center">
                    <span className="text-[11px] uppercase tracking-wider text-text-secondary">not run yet</span>
                    <Button tier="ghost" onClick={runDry}>
                      DRY RUN
                    </Button>
                  </div>
                )}
                {!dryRun && busy === 'running' && <SkeletonRows rows={4} />}
                {dryRun && (
                  <div style={{ opacity: busy === 'running' ? 0.7 : 1 }} className="flex flex-col gap-3">
                    <DecisionMeta decision={dryRun} linkStrategy={false} />
                    <DecisionView decision={dryRun} />
                  </div>
                )}
              </div>
            </div>

            {data.last_decision_id && (
              <div className="panel">
                <div className="panel-header">
                  <span className="panel-title">LAST DECISION</span>
                  <Link
                    to={`/decisions/${data.last_decision_id}`}
                    className="text-[10px] uppercase tracking-wider text-text-secondary hover:text-text-primary"
                  >
                    OPEN →
                  </Link>
                </div>
                <div className="panel-body p-3 text-[10px] tabular text-text-secondary flex flex-wrap gap-x-3 gap-y-1">
                  <span className="text-text-muted truncate max-w-full">{data.last_decision_id}</span>
                  <span title={fmtTs(data.last_run_at)}>RAN {fmtAge(data.last_run_at)}</span>
                  {data.next_run_at && <span title={fmtTs(data.next_run_at)}>NEXT {fmtTs(data.next_run_at)}</span>}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
