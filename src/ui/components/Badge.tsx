import type { ReactNode } from 'react'

// Badge, StatusDot — DESIGN.md §3/§11. Ported from Hyperion; DirectionChip
// dropped (no positions in this product — MomentumBadge replaces it, see
// MomentumBadge.tsx). Color is never the sole signal: StatusDot always
// ships with a text label from its caller.

export type Tone = 'green' | 'red' | 'amber' | 'info' | 'gray'

const TONE_TEXT: Record<Tone, string> = {
  green: 'text-green',
  red: 'text-red-text',
  amber: 'text-amber',
  info: 'text-info',
  gray: 'text-text-secondary',
}

const TONE_BG: Record<Tone, string> = {
  green: 'bg-green-bg',
  red: 'bg-red-bg',
  amber: 'bg-amber-bg',
  info: 'bg-info-bg',
  gray: 'bg-elevated',
}

export interface BadgeProps {
  tone: Tone
  children: ReactNode
  variant?: 'solid' | 'outline'
  className?: string
}

export function Badge({ tone, children, variant = 'solid', className = '' }: BadgeProps) {
  const base = 'inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] uppercase tracking-wider border font-mono'
  const look =
    variant === 'outline'
      ? `border-current ${TONE_TEXT[tone]} bg-transparent`
      : `border-transparent ${TONE_TEXT[tone]} ${TONE_BG[tone]}`
  return <span className={`${base} ${look} ${className}`}>{children}</span>
}

export type DotStatus = 'ok' | 'degraded' | 'down' | 'unknown'

const DOT_CLASS: Record<DotStatus, string> = {
  ok: 'bg-green',
  degraded: 'bg-amber',
  down: 'bg-red',
  unknown: 'bg-text-secondary/40',
}

// StatusDot — 6x6px square. Always pair with a text label at the call site.
export function StatusDot({ status, className = '' }: { status: DotStatus; className?: string }) {
  return <span className={`inline-block w-1.5 h-1.5 flex-shrink-0 ${DOT_CLASS[status]} ${className}`} />
}
