import type { CSSProperties, ReactNode } from 'react'
import { Badge } from '../Badge'
import { SrcTag, type Source } from '../SrcTag'
import { dsrTitle, dsrTone, fmtDsr, isStaleDate, sharpeCell, verdictBadge, verdictOf, type Direction, type PerfStats } from '../../lib/lab'

// Small pieces every /lab surface repeats (DESIGN.md §10.9).

const LAB_SOURCES = new Set<string>(['ht', 'cm', 'fng', 'llama', 'hl', 'cg', 'fred', 'elfa'])

export function ProviderTag({ provider, className }: { provider: string; className?: string }) {
  if (!LAB_SOURCES.has(provider)) return <span className={`src-tag ${className ?? ''}`}>{provider.toUpperCase()}</span>
  return <SrcTag source={provider as Source} className={className} />
}

/** `data to 2026-10-07` — amber past 2 days, exact date in the title. */
export function DataTo({ date }: { date: string }) {
  const stale = isStaleDate(date)
  return (
    <span className={stale ? 'text-amber' : undefined} title={stale ? `data older than 2 days (${date})` : date}>
      data to {date}
    </span>
  )
}

/** Honesty rule 3: disclaimer + slippage + data age on every result surface. */
export function LabFooter({ dataTo, slippageBps = 10, className = '' }: { dataTo?: string | null; slippageBps?: number; className?: string }) {
  return (
    <p className={`text-xs text-text-secondary ${className}`}>
      historical research, not advice · net of {slippageBps} bps slippage
      {dataTo ? (
        <>
          {' · '}
          <DataTo date={dataTo} />
        </>
      ) : null}
    </p>
  )
}

export function DirectionWord({ direction, className = '' }: { direction: Direction; className?: string }) {
  return <span className={`${direction === 'long' ? 'text-green' : 'text-red-text'} ${className}`}>{direction.toUpperCase()}</span>
}

/** Mini stat cell: label (xs secondary) over value. */
export function StatCell({ label, children, title }: { label: string; children: ReactNode; title?: string }) {
  return (
    <div className="flex flex-col gap-0.5 min-w-0" title={title}>
      <span className="text-xs text-text-secondary uppercase">{label}</span>
      <span className="tabular text-sm text-text-primary flex flex-wrap items-center gap-1">{children}</span>
    </div>
  )
}

/** Field wrapper with a visible .label and an inline 11px red error. */
export function Field({ label, error, children, htmlFor }: { label: ReactNode; error?: string | null; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="flex flex-col gap-1 min-w-0">
      {htmlFor ? (
        <label htmlFor={htmlFor} className="label">
          {label}
        </label>
      ) : (
        <span className="label">{label}</span>
      )}
      {children}
      {error && <span className="text-sm text-red-text">{error}</span>}
    </div>
  )
}

/** Inline style that outlines an input the server named in a 400 (unlayered input CSS beats utilities). */
export function invalidStyle(invalid: boolean): CSSProperties | undefined {
  return invalid ? { borderColor: 'var(--color-red)' } : undefined
}

/** Server verdict as a Badge, reasons in the title; nothing when the evaluation carries none. */
export function VerdictBadge({ ev, className = '' }: { ev: object | null | undefined; className?: string }) {
  const v = verdictOf(ev)
  if (!v) return null
  const b = verdictBadge(v.level)
  return (
    <span className={`inline-flex ${className}`} title={v.reasons.length ? v.reasons.join('\n') : undefined}>
      <Badge tone={b.tone}>{b.label}</Badge>
    </span>
  )
}

/** A window's Sharpe: signed + toned, `untested` when the window holds no trade, `—` when missing. */
export function SharpeValue({ stats, className = '' }: { stats: PerfStats | null | undefined; className?: string }) {
  const c = sharpeCell(stats)
  return (
    <span className={`${c.tone} ${className}`} title={c.title}>
      {c.text}
    </span>
  )
}

/** Deflated Sharpe, 2 decimals, title naming N. */
export function DsrValue({ dsr, n, className = '' }: { dsr: number | null | undefined; n?: number | null; className?: string }) {
  return (
    <span className={`${dsrTone(dsr)} ${className}`} title={dsrTitle(n)}>
      {fmtDsr(dsr)}
    </span>
  )
}
