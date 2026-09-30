import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Badge, StatusDot } from '../Badge'
import { Segmented } from '../Segmented'
import type { AnalystCatalog, AnalystCatalogModel, AnalystChoice, AnalystEffort, AnalystProviderId } from '../../lib/analyst'

// ModelSelector — Analyst page header control (DESIGN.md language: dark,
// Geist Mono, zero border-radius, hairline borders, 220ms motion, no
// spinners). Trigger is a pill "PROVIDER · Model" with an availability dot
// (state colours §6) and a tier tag. Clicking opens a popover on desktop /
// bottom sheet on mobile (§4) listing providers as group headers and models
// as `--row-h` touch rows (label, note, tier tag, check on the current
// one). Unavailable providers render dimmed with their reason. An effort
// segmented control (low/medium/high/xhigh/max) sits inline next to the
// pill, shown only when the selected model supports it.
//
// Fully controlled: the caller (src/ui/pages/Analyst.tsx) owns `value`,
// persists it to localStorage (`ht_analyst_model`) and validates it against
// the catalog on load, falling back to `catalog.default` when stale.

const EFFORT_OPTIONS = (['low', 'medium', 'high', 'xhigh', 'max'] as const satisfies readonly AnalystEffort[]).map((v) => ({
  value: v,
  label: v,
}))

const TIER_LABEL: Record<AnalystCatalogModel['tier'], string> = {
  frontier: 'FRONTIER',
  balanced: 'BALANCED',
  fast: 'FAST',
}

const TIER_TONE: Record<AnalystCatalogModel['tier'], 'info' | 'gray' | 'green'> = {
  frontier: 'info',
  balanced: 'gray',
  fast: 'green',
}

function TierTag({ tier }: { tier: AnalystCatalogModel['tier'] }) {
  return <Badge tone={TIER_TONE[tier]}>{TIER_LABEL[tier]}</Badge>
}

export interface ModelSelectorProps {
  /** null while GET /api/analyst/models is loading → skeleton pill. */
  catalog: AnalystCatalog | null
  /** The current selection; should already be catalog-valid when set. */
  value: AnalystChoice | null
  onChange: (choice: AnalystChoice) => void
  /** Controlled open state (tests / advanced callers); uncontrolled by default. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

interface FlatOption {
  providerId: AnalystProviderId
  providerLabel: string
  model: AnalystCatalogModel
}

function flatten(catalog: AnalystCatalog): FlatOption[] {
  const out: FlatOption[] = []
  for (const p of catalog.providers) for (const m of p.models) out.push({ providerId: p.id, providerLabel: p.label, model: m })
  return out
}

export function ModelSelector({ catalog, value, onChange, open: openProp, onOpenChange }: ModelSelectorProps) {
  const [openState, setOpenState] = useState(false)
  const open = openProp ?? openState
  const setOpen = (v: boolean) => {
    setOpenState(v)
    onOpenChange?.(v)
  }
  const [activeIndex, setActiveIndex] = useState(0)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const optionRefs = useRef<Array<HTMLDivElement | null>>([])

  // Only available providers' models are keyboard-navigable/selectable.
  const navigable = useMemo(() => (catalog ? flatten(catalog).filter((o) => catalog.providers.find((p) => p.id === o.providerId)?.available) : []), [catalog])

  const anyAvailable = catalog ? catalog.providers.some((p) => p.available) : false
  // A selection only counts when its provider is actually available — a
  // stale/fallback `value` can still name a real model of an unconfigured
  // provider (e.g. the caller's last-resort default when nothing is
  // configured at all); that must render as "no selection", not as a
  // working pick with its effort control showing next to "NO PROVIDER".
  const selected =
    catalog && value ? navigable.find((o) => o.providerId === value.provider && o.model.id === value.model) : undefined

  useEffect(() => {
    if (!open) return
    const idx = Math.max(
      0,
      navigable.findIndex((o) => o.providerId === value?.provider && o.model.id === value?.model),
    )
    setActiveIndex(idx)
    const onDoc = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    if (open) optionRefs.current[activeIndex]?.focus()
  }, [open, activeIndex])

  if (!catalog) {
    return <div className="h-[var(--control-md)] w-[170px] bg-elevated pulse-label" aria-hidden="true" data-testid="model-selector-skeleton" />
  }

  const pick = (o: FlatOption) => {
    onChange({ provider: o.providerId, model: o.model.id, effort: o.model.effort ? (value?.effort ?? 'medium') : undefined })
    setOpen(false)
    triggerRef.current?.focus()
  }

  const onListKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (navigable.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex((i) => (i + 1) % navigable.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex((i) => (i - 1 + navigable.length) % navigable.length)
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      const o = navigable[activeIndex]
      if (o) pick(o)
    } else if (e.key === 'Tab') {
      // Minimal focus trap: the listbox is the only focusable region.
      e.preventDefault()
    }
  }

  const onTriggerKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (!open && (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault()
      setOpen(true)
    }
  }

  const reasons = catalog.providers
    .map((p) => p.reason)
    .filter((r): r is string => !!r)
    .join(' · ')

  return (
    // Mobile (<md): stacked column — pill on its own full-width row, effort
    // control (when shown) on its own row beneath, left-aligned, no
    // horizontal scroll (DESIGN.md forbids it). Desktop: the original
    // single inline row.
    <div className="relative flex flex-col items-start gap-2 w-full md:inline-flex md:flex-row md:items-center md:w-auto" ref={containerRef}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Analyst model selector"
        onClick={() => setOpen(!open)}
        onKeyDown={onTriggerKeyDown}
        className="flex md:inline-flex items-center gap-1.5 w-full md:w-auto min-w-0 h-[var(--control-md)] px-2 border border-border bg-elevated text-[10px] uppercase tracking-wider text-text-primary hover:bg-hover transition-colors duration-100 whitespace-nowrap"
      >
        <StatusDot status={selected ? 'ok' : 'down'} />
        {selected ? (
          <>
            <span className="shrink-0">{selected.providerLabel}</span>
            <span className="text-text-secondary shrink-0">·</span>
            <span className="normal-case text-text-primary min-w-0 truncate">{selected.model.label}</span>
            <TierTag tier={selected.model.tier} />
          </>
        ) : (
          <span>NO PROVIDER</span>
        )}
      </button>

      {!anyAvailable && reasons && <span className="text-[10px] text-text-secondary normal-case">{reasons}</span>}

      {selected?.model.effort && (
        <Segmented
          label="Reasoning effort"
          size="md"
          options={EFFORT_OPTIONS}
          value={value?.effort ?? 'medium'}
          onChange={(effort) => onChange({ provider: selected.providerId, model: selected.model.id, effort })}
        />
      )}

      {open && (
        <>
          <div className="fixed inset-0 z-40 md:hidden" style={{ background: 'var(--color-scrim)' }} onMouseDown={() => setOpen(false)} />
          <div
            role="listbox"
            aria-label="Select analyst model"
            onKeyDown={onListKeyDown}
            className="fixed inset-x-0 bottom-0 z-50 md:absolute md:inset-auto md:top-full md:left-0 md:mt-1 md:w-[340px] panel max-h-[70vh] overflow-auto divide-y divide-border-subtle"
          >
            {catalog.providers.map((p) => (
              <div key={p.id} role="group" aria-label={p.label}>
                <div className={`px-2 py-1 label flex flex-wrap items-center gap-2 ${p.available ? '' : 'opacity-50'}`}>
                  <span>{p.label}</span>
                  {!p.available && p.reason && <span className="normal-case text-text-secondary tracking-normal">{p.reason}</span>}
                </div>
                {p.models.map((m) => {
                  const flatIdx = navigable.findIndex((o) => o.providerId === p.id && o.model.id === m.id)
                  const isSelected = value?.provider === p.id && value?.model === m.id
                  const disabled = !p.available
                  return (
                    <div
                      key={m.id}
                      ref={(el) => {
                        if (flatIdx >= 0) optionRefs.current[flatIdx] = el
                      }}
                      role="option"
                      aria-selected={isSelected}
                      aria-disabled={disabled || undefined}
                      tabIndex={disabled ? -1 : flatIdx === activeIndex ? 0 : -1}
                      onClick={() => !disabled && pick({ providerId: p.id, providerLabel: p.label, model: m })}
                      className={`flex items-center gap-2 px-2 min-h-[var(--row-h)] ${
                        disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer hover:bg-hover'
                      } ${isSelected ? 'bg-selected' : ''}`}
                    >
                      <span className="w-3 shrink-0 text-text-primary">{isSelected ? '✓' : ''}</span>
                      <span className="flex-1 min-w-0 flex flex-col py-1">
                        <span className="text-[12px] text-text-primary">{m.label}</span>
                        <span className="text-[10px] text-text-secondary truncate">{m.note}</span>
                      </span>
                      <TierTag tier={m.tier} />
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
