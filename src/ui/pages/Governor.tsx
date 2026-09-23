import { useCallback, useEffect, useState } from 'react'
import { Badge, Button, ConfirmDialog, EmptyBlock, ErrorBlock, SkeletonRows } from '../components'
import { engine, errorMessage, useEngine } from '../lib/engine'
import type { GovernorMode, GovernorSettings, VenueStatus } from '../../shared/strategy-protocol'
import { EngineTabs } from '../components/strategy/EngineTabs'
import { EngineOffline, OfflineStrip } from '../components/strategy/EngineOffline'
import { fmtUsdSigned } from '../components/strategy/format'

// /governor — global mode, limits, and the kill switch. Mode chips + three
// numeric limits save through PUT /governor (Level 1, verbatim ErrorBlock).
// The kill switch is the one typed-word confirmation in this product: it
// disables every strategy and rejects every open proposal, and the core
// offers no un-kill route, so DESIGN.md §7's Level 2 dialog gains a typed
// word (KILL) here and nowhere else. Venues render beneath: status,
// capabilities, open positions — the surface the kill switch acts on.

const MODES: { value: GovernorMode; label: string; hint: string }[] = [
  { value: 'manual', label: 'MANUAL', hint: 'every intent waits for the operator' },
  { value: 'threshold', label: 'THRESHOLD', hint: 'auto-approve above min confidence, within limits' },
  { value: 'auto', label: 'AUTO', hint: 'auto-approve within limits' },
]

interface Form {
  mode: GovernorMode
  min_confidence: string
  max_notional_usd: string
  max_open_intents: string
}

function toForm(g: GovernorSettings): Form {
  return {
    mode: g.mode,
    min_confidence: String(g.min_confidence),
    max_notional_usd: String(g.max_notional_usd),
    max_open_intents: String(g.max_open_intents),
  }
}

function validate(f: Form): Record<string, string> {
  const e: Record<string, string> = {}
  const mc = Number(f.min_confidence)
  if (f.min_confidence.trim() === '' || Number.isNaN(mc) || mc < 0 || mc > 1) e.min_confidence = 'must be between 0 and 1'
  const mn = Number(f.max_notional_usd)
  if (f.max_notional_usd.trim() === '' || Number.isNaN(mn) || mn < 0) e.max_notional_usd = 'must be ≥ 0'
  const mo = Number(f.max_open_intents)
  if (f.max_open_intents.trim() === '' || Number.isNaN(mo) || mo < 0 || !Number.isInteger(mo)) e.max_open_intents = 'must be a whole number ≥ 0'
  return e
}

function venueDot(status: string): 'green' | 'amber' | 'red' | 'gray' {
  const s = status.toLowerCase()
  if (s === 'connected' || s === 'ok' || s === 'ready') return 'green'
  if (s === 'degraded' || s === 'connecting') return 'amber'
  if (s === 'down' || s === 'error' || s === 'disconnected') return 'red'
  return 'gray'
}

/** One line of an evm venue's meta: "mainnet · chain 143 · block 41,234,567 · 3.2 MON · 0x12ab…cdef · uniswap_v3". */
function venueMeta(v: VenueStatus): string {
  const m = v.meta
  if (!m) return ''
  const parts: string[] = []
  if (typeof m.network === 'string') parts.push(m.network)
  if (typeof m.chain_id === 'number') parts.push(`chain ${m.chain_id}`)
  if (typeof m.head_block === 'number') parts.push(`block ${m.head_block.toLocaleString()}`)
  if (typeof m.native_balance === 'number') parts.push(`${m.native_balance.toFixed(4)} ${typeof m.native_symbol === 'string' ? m.native_symbol : ''}`.trim())
  if (typeof m.address === 'string') parts.push(m.address.length > 12 ? `${m.address.slice(0, 6)}…${m.address.slice(-4)}` : m.address)
  if (typeof m.protocol === 'string') parts.push(m.protocol)
  return parts.join(' · ')
}

function VenuesPanel() {
  const { data, loading, error, offline, fetchedAt, refetch } = useEngine(() => engine.listVenues(), [])
  return (
    <div className="panel">
      {offline && data && <OfflineStrip reason={offline} fetchedAt={fetchedAt} />}
      <div className="panel-header">
        <span className="panel-title">VENUES</span>
        {data && <span className="text-[10px] text-text-secondary tabular">{data.length}</span>}
      </div>
      <div className="panel-body">
        {loading && !data && <SkeletonRows rows={2} />}
        {!loading && offline && !data && <EngineOffline reason={offline} onRetry={refetch} />}
        {!loading && !offline && error && !data && <ErrorBlock message={error} onRetry={refetch} />}
        {data && data.length === 0 && <EmptyBlock label="no venues registered" />}
        {data && data.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-border-subtle">
            {data.map((v: VenueStatus) => (
              <div key={v.id} className="p-3 flex flex-col gap-2 min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-text-primary text-[13px]">{v.id}</span>
                  <Badge tone={venueDot(v.status)}>{v.status}</Badge>
                  <span className="text-[10px] text-text-secondary">
                    {v.kind}
                    {v.chain && v.chain !== 'none' ? ` · ${v.chain}` : ''}
                  </span>
                </div>
                {venueMeta(v) && <span className="text-[10px] text-text-secondary tabular break-all">{venueMeta(v)}</span>}
                {v.error && <span className="text-[11px] text-red-text break-words" role="alert">{v.error}</span>}
                <div className="flex flex-wrap gap-1">
                  {v.capabilities.length === 0 && <span className="text-[10px] text-text-secondary">no capabilities</span>}
                  {v.capabilities.map((c) => (
                    <span key={c} className="src-tag">
                      {c}
                    </span>
                  ))}
                </div>
                {v.positions.length === 0 ? (
                  <span className="text-[10px] uppercase tracking-wider text-text-secondary">no open positions</span>
                ) : (
                  <div className="table-scroll">
                    <table className="w-full text-[11px] tabular border-collapse">
                      <thead>
                        <tr className="border-b border-border">
                          <th className="px-2 py-1 label text-left">MARKET</th>
                          <th className="px-2 py-1 label text-right">SIZE</th>
                          <th className="px-2 py-1 label text-right hidden md:table-cell">ENTRY</th>
                          <th className="px-2 py-1 label text-right hidden md:table-cell">MARK</th>
                          <th className="px-2 py-1 label text-right">UPNL</th>
                        </tr>
                      </thead>
                      <tbody>
                        {v.positions.map((p) => (
                          <tr key={p.market} className="border-b border-border-subtle" style={{ height: 'var(--row-h)' }}>
                            <td className="px-2 text-text-primary">{p.market}</td>
                            <td className={`px-2 text-right ${p.size_usd < 0 ? 'text-red-text' : 'text-green'}`}>
                              {fmtUsdSigned(p.size_usd)} {p.size_usd < 0 ? 'SHORT' : 'LONG'}
                            </td>
                            <td className="px-2 text-right text-text-muted hidden md:table-cell">{p.entry ? p.entry : '—'}</td>
                            <td className="px-2 text-right text-text-muted hidden md:table-cell">{p.mark ?? '—'}</td>
                            <td
                              className={`px-2 text-right ${
                                p.upnl_usd == null ? 'text-text-secondary' : p.upnl_usd < 0 ? 'text-red-text' : p.upnl_usd > 0 ? 'text-green' : 'text-text-muted'
                              }`}
                            >
                              {fmtUsdSigned(p.upnl_usd)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export function Governor() {
  const governor = useEngine(() => engine.getGovernor(), [])
  const [form, setForm] = useState<Form | null>(null)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [killOpen, setKillOpen] = useState(false)
  const [killBusy, setKillBusy] = useState(false)
  const [killError, setKillError] = useState<string | null>(null)

  useEffect(() => {
    if (governor.data && form === null) setForm(toForm(governor.data))
  }, [governor.data, form])

  // A kill from elsewhere (terminal, another tab) must show here on the next
  // poll even while the form is dirty.
  const killed = governor.data?.killed ?? false

  const closeKill = useCallback(() => {
    if (killBusy) return
    setKillOpen(false)
    setKillError(null)
  }, [killBusy])

  const errors = form ? validate(form) : {}
  const valid = Object.keys(errors).length === 0

  async function save() {
    if (!form || !valid || !governor.data) return
    setSaving(true)
    setSaveError(null)
    try {
      const updated = await engine.putGovernor({
        mode: form.mode,
        min_confidence: Number(form.min_confidence),
        max_notional_usd: Number(form.max_notional_usd),
        max_open_intents: Number(form.max_open_intents),
        killed: governor.data.killed,
      })
      governor.setData(updated)
      setForm(toForm(updated))
      setDirty(false)
    } catch (err) {
      setSaveError(errorMessage(err, 'save failed'))
    } finally {
      setSaving(false)
    }
  }

  async function kill() {
    setKillBusy(true)
    setKillError(null)
    try {
      const updated = await engine.kill()
      governor.setData(updated)
      setForm(toForm(updated))
      setDirty(false)
      setKillOpen(false)
    } catch (err) {
      setKillError(errorMessage(err, 'kill failed'))
    } finally {
      setKillBusy(false)
    }
  }

  const { data, loading, error, offline, fetchedAt, refetch } = governor

  return (
    <div className="max-w-[1440px] mx-auto p-3 md:p-[var(--gutter)]">
      <EngineTabs />
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-3">
        <div className="lg:col-span-5 panel">
          {offline && data && <OfflineStrip reason={offline} fetchedAt={fetchedAt} />}
          {killed && (
            <div role="status" className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-red-text bg-red-bg border-b border-border-subtle">
              killed — every strategy disabled, open proposals rejected. re-enable from the core.
            </div>
          )}
          <div className="panel-header">
            <span className="flex items-center gap-1.5">
              <span className="panel-title">GOVERNOR</span>
              {dirty && <span className="inline-block w-1.5 h-1.5 bg-amber" title="unsaved changes" />}
            </span>
            {data && <Badge tone={killed ? 'red' : 'green'}>{killed ? 'KILLED' : 'LIVE'}</Badge>}
          </div>
          <div className="panel-body p-3 flex flex-col gap-3">
            {loading && !data && <SkeletonRows rows={4} />}
            {!loading && offline && !data && <EngineOffline reason={offline} onRetry={refetch} />}
            {!loading && !offline && error && !data && <ErrorBlock message={error} onRetry={refetch} />}
            {data && error && <ErrorBlock message={error} onRetry={refetch} />}

            {form && (
              <>
                <div className="flex flex-col gap-1">
                  <span className="label">MODE</span>
                  <div className="flex flex-wrap gap-1.5">
                    {MODES.map((m) => (
                      <button
                        key={m.value}
                        type="button"
                        title={m.hint}
                        onClick={() => {
                          setForm((f) => (f ? { ...f, mode: m.value } : f))
                          setDirty(true)
                        }}
                        className={`h-[var(--control-md)] px-3 text-[10px] font-mono uppercase border border-border ${
                          form.mode === m.value ? 'text-text-primary bg-selected' : 'text-text-secondary'
                        }`}
                      >
                        {m.label}
                      </button>
                    ))}
                  </div>
                  <span className="text-[10px] text-text-secondary">{MODES.find((m) => m.value === form.mode)?.hint}</span>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
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
                        value={form[key]}
                        aria-invalid={!!errors[key]}
                        onChange={(e) => {
                          const v = e.target.value
                          setForm((f) => (f ? { ...f, [key]: v } : f))
                          setDirty(true)
                        }}
                        className="w-full"
                      />
                      {errors[key] && (
                        <span role="alert" className="text-[10px] text-red-text">
                          {errors[key]}
                        </span>
                      )}
                    </label>
                  ))}
                </div>

                {saveError && <ErrorBlock message={saveError} />}

                <Button tier="neutral" onClick={save} disabled={!valid || saving || !dirty}>
                  <span className={saving ? 'pulse-label' : undefined}>{saving ? 'SAVING…' : 'SAVE'}</span>
                </Button>

                <div className="flex flex-col gap-1.5 pt-3 border-t border-border-subtle">
                  <span className="label">KILL SWITCH</span>
                  <Button tier="danger" onClick={() => setKillOpen(true)} disabled={killed} style={{ height: 'var(--control-lg)' }}>
                    {killed ? 'KILLED' : 'KILL SWITCH'}
                  </Button>
                  <span className="text-[10px] text-text-secondary">
                    disables every strategy and rejects open proposals — there is no un-kill from here
                  </span>
                </div>
              </>
            )}
          </div>
        </div>

        <div className="lg:col-span-7">
          <VenuesPanel />
        </div>
      </div>

      {killOpen && (
        <ConfirmDialog
          title="KILL SWITCH"
          body="Kill the engine? Every strategy is disabled and every open proposal is rejected. Positions already on a venue stay open."
          confirmLabel="KILL ENGINE"
          typedWord="KILL"
          onConfirm={kill}
          onCancel={closeKill}
          error={killError}
          busy={killBusy}
        />
      )}
    </div>
  )
}
