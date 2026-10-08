import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { ErrorBlock, SkeletonRows } from '../state'
import { metricAvailable, type LabState, type MetricDef } from '../../lib/lab'
import { ProviderTag } from './common'

// MetricPicker — DESIGN.md §10.9. Trigger reads `6 METRICS ▾`; selected
// metrics render as removable chips. Opens as a popover (md+) or a
// focus-trapped bottom sheet (mobile); search, groups `PROVIDER · CATEGORY ·
// n`, one real checkbox per metric. Selection applies live; Esc closes and
// restores focus to the trigger. Metrics not offered for the typed asset are
// hidden and counted in the footer.

export const METRIC_CAP = 40

export function MetricPicker({
  metrics,
  selected,
  asset,
  onChange,
  onClose,
  disabled,
  invalid,
}: {
  metrics: LabState<MetricDef[]>
  selected: string[]
  asset: string
  onChange: (ids: string[]) => void
  onClose: () => void
  disabled: boolean
  invalid: boolean
}) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const all = metrics.data ?? []
  const byId = useMemo(() => new Map(all.map((m) => [m.id, m])), [all])
  const n = selected.length

  const close = () => {
    setOpen(false)
    onClose()
    triggerRef.current?.focus()
  }

  const remove = (id: string) => {
    onChange(selected.filter((x) => x !== id))
    onClose()
  }

  return (
    <div className="relative flex flex-col gap-1.5">
      <button
        ref={triggerRef}
        type="button"
        id="lab-metrics"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-invalid={invalid || undefined}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className="h-[var(--control-md)] px-2 flex items-center justify-between border border-border rounded-control text-xs font-control uppercase hover:bg-hover disabled:text-text-disabled"
        style={invalid ? { borderColor: 'var(--color-red)' } : undefined}
      >
        <span className={n === 0 ? 'text-text-secondary' : n >= METRIC_CAP ? 'text-amber' : 'text-text-primary'}>
          {n >= METRIC_CAP ? `${n}/${METRIC_CAP}` : n} METRICS
        </span>
        <span aria-hidden="true" className="text-text-secondary">
          ▾
        </span>
      </button>

      {n > 0 && (
        <ul aria-label="selected metrics" className="flex flex-wrap gap-1">
          {selected.map((id) => {
            const m = byId.get(id)
            return (
              <li key={id} className="inline-flex items-center gap-1 h-[var(--control-sm)] pl-1.5 border border-border-subtle bg-elevated text-xs">
                <span className="text-text-primary">{m?.name ?? id}</span>
                <ProviderTag provider={m?.provider ?? id.split(':')[0] ?? ''} />
                <button
                  type="button"
                  aria-label={`remove ${m?.name ?? id}`}
                  disabled={disabled}
                  onClick={() => remove(id)}
                  className="h-full min-w-[var(--tap-min)] px-1 text-text-secondary hover:text-text-primary"
                >
                  ✕
                </button>
              </li>
            )
          })}
        </ul>
      )}

      {open && <PickerPanel metrics={metrics} selected={selected} asset={asset} onChange={onChange} onClose={close} />}
    </div>
  )
}

function PickerPanel({
  metrics,
  selected,
  asset,
  onChange,
  onClose,
}: {
  metrics: LabState<MetricDef[]>
  selected: string[]
  asset: string
  onChange: (ids: string[]) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const panelRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const atCap = selected.length >= METRIC_CAP
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    searchRef.current?.focus()
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element
      if (panelRef.current && !panelRef.current.contains(t) && !t.closest?.('#lab-metrics')) closeRef.current()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [])

  const { groups, hidden } = useMemo(() => {
    const q = query.trim().toLowerCase()
    const groups = new Map<string, MetricDef[]>()
    let hidden = 0
    for (const m of metrics.data ?? []) {
      if (!metricAvailable(m, asset)) {
        hidden++
        continue
      }
      if (q && !`${m.name} ${m.id} ${m.description}`.toLowerCase().includes(q)) continue
      const key = `${m.provider} · ${m.category}`
      const list = groups.get(key) ?? []
      list.push(m)
      groups.set(key, list)
    }
    return { groups: [...groups.entries()], hidden }
  }, [metrics.data, query, asset])

  const toggle = (id: string, on: boolean) => onChange(on ? [...selected, id] : selected.filter((x) => x !== id))

  // Esc closes; Tab cycles inside (the sheet traps focus).
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      onClose()
      return
    }
    if (e.key !== 'Tab' || !panelRef.current) return
    const focusables = panelRef.current.querySelectorAll<HTMLElement>('input:not(:disabled), button:not(:disabled)')
    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    if (!first || !last) return
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }

  return (
    <>
      <div className="fixed inset-0 z-40 md:hidden" style={{ background: 'var(--color-scrim)' }} onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="lab-metrics-title"
        onKeyDown={onKeyDown}
        className="panel fixed inset-x-0 bottom-0 z-50 h-[80dvh] md:absolute md:inset-x-auto md:bottom-auto md:left-0 md:top-full md:mt-1 md:w-[360px] md:h-auto md:max-h-[420px]"
        style={{ boxShadow: 'var(--shadow-overlay)' }}
      >
        <div className="panel-header">
          <span id="lab-metrics-title" className="panel-title">
            METRICS
          </span>
          <button type="button" onClick={onClose} aria-label="close metrics" className="text-text-secondary hover:text-text-primary min-w-[var(--tap-min)]">
            ✕
          </button>
        </div>
        <div className="p-2 border-b border-border-subtle">
          <label htmlFor="lab-metric-search" className="sr-only">
            search metrics
          </label>
          <input
            ref={searchRef}
            id="lab-metric-search"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="search name, id, description"
            className="w-full"
            autoComplete="off"
          />
        </div>
        <div className="flex-1 min-h-0 overflow-auto">
          {metrics.loading && !metrics.data ? (
            <SkeletonRows rows={4} />
          ) : metrics.error || metrics.offline ? (
            <ErrorBlock message={metrics.error ?? 'API unreachable'} onRetry={metrics.refetch} />
          ) : groups.length === 0 ? (
            <p className="px-3 py-4 text-xs text-text-secondary">no metric matches</p>
          ) : (
            groups.map(([key, list]) => {
              const isCollapsed = collapsed.has(key)
              return (
                <div key={key}>
                  <button
                    type="button"
                    aria-expanded={!isCollapsed}
                    onClick={() =>
                      setCollapsed((s) => {
                        const next = new Set(s)
                        if (next.has(key)) next.delete(key)
                        else next.add(key)
                        return next
                      })
                    }
                    className="label w-full flex items-center gap-1.5 px-2 h-[var(--control-md)] bg-panel-alt hover:bg-hover text-left"
                  >
                    <span aria-hidden="true">{isCollapsed ? '▸' : '▾'}</span>
                    {key} · {list.length}
                  </button>
                  {!isCollapsed &&
                    list.map((m) => {
                      const checked = selected.includes(m.id)
                      return (
                        <label
                          key={m.id}
                          className={`flex items-center gap-2 px-2 min-h-[var(--row-h)] ${atCap && !checked ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:bg-hover'}`}
                          title={m.description}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={atCap && !checked}
                            onChange={(e) => toggle(m.id, e.target.checked)}
                            className="min-h-0"
                          />
                          <span className="text-sm text-text-primary truncate">{m.name}</span>
                          <ProviderTag provider={m.provider} />
                          {m.units && <span className="text-xs text-text-secondary truncate">{m.units}</span>}
                          {m.lagDays > 0 && <span className="text-xs text-text-secondary ml-auto">LAG {m.lagDays}D</span>}
                        </label>
                      )
                    })}
                </div>
              )
            })
          )}
        </div>
        {hidden > 0 && (
          <p className="px-3 py-1.5 border-t border-border-subtle text-xs text-text-secondary">
            {hidden} hidden — not available for {asset.trim().toUpperCase() || 'this asset'}
          </p>
        )}
      </div>
    </>
  )
}
