import { useEffect, useReducer } from 'react'

// RevealPnl — a live dollar P&L that stays hidden until asked for. The desk
// never ticks money at the operator: the value sits behind a quiet "$ ···"
// placeholder and shows on click/tap, Enter/Space or mouse hover, then hides
// again after REVEAL_MS (or on mouse leave once that time has passed). The
// caller formats the value and picks its tone; this component only gates it.

export const REVEAL_MS = 4_000
export const PNL_PLACEHOLDER = '$ ···'

export interface RevealState {
  shown: boolean
  /** A mouse pointer is over the button (touch never sets it). */
  hover: boolean
  /** The reveal window has run out; the value hides once the pointer leaves. */
  expired: boolean
  /** Bumped on every fresh reveal so the hide timer restarts. */
  seq: number
}

export type RevealEvent = 'activate' | 'enter' | 'leave' | 'expire'

export const REVEAL_INITIAL: RevealState = { shown: false, hover: false, expired: false, seq: 0 }

/** Pure state machine behind RevealPnl. `activate` = click, tap, Enter or Space. */
export function revealReducer(s: RevealState, e: RevealEvent): RevealState {
  switch (e) {
    case 'activate':
      return s.shown ? { ...s, shown: false, expired: false } : { ...s, shown: true, expired: false, seq: s.seq + 1 }
    case 'enter':
      return s.shown ? { ...s, hover: true } : { ...s, hover: true, shown: true, expired: false, seq: s.seq + 1 }
    case 'leave':
      return { ...s, hover: false, shown: s.shown && !s.expired }
    case 'expire':
      return { ...s, expired: true, shown: s.hover ? s.shown : false }
  }
}

export interface RevealPnlProps {
  /** The formatted value, e.g. "+$412.50". Shown only while revealed. */
  value: string
  /** What the value is, for the accessible name: "day P&L", "SOL unrealized P&L". */
  label: string
  /** Classes for the revealed value (tone). The placeholder is always muted. */
  className?: string
  /** How long a reveal lasts, in ms. */
  revealMs?: number
  /** Initial state, for tests and static renders. */
  initial?: RevealState
}

export function RevealPnl({ value, label, className = 'text-text-primary', revealMs = REVEAL_MS, initial = REVEAL_INITIAL }: RevealPnlProps) {
  const [s, dispatch] = useReducer(revealReducer, initial)

  useEffect(() => {
    if (!s.shown || s.expired) return
    const t = setTimeout(() => dispatch('expire'), revealMs)
    return () => clearTimeout(t)
  }, [s.shown, s.expired, s.seq, revealMs])

  return (
    <button
      type="button"
      aria-label={s.shown ? `${label} ${value}` : `${label} hidden, press to show for ${Math.round(revealMs / 1000)} seconds`}
      aria-pressed={s.shown}
      title={s.shown ? undefined : `show ${label}`}
      onClick={(e) => {
        e.stopPropagation()
        dispatch('activate')
      }}
      // Enter/Space already fire click on a <button>; stop them reaching a clickable table row.
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') e.stopPropagation()
      }}
      onPointerEnter={(e) => e.pointerType === 'mouse' && dispatch('enter')}
      onPointerLeave={(e) => e.pointerType === 'mouse' && dispatch('leave')}
      className="reveal-pnl inline-grid tabular cursor-pointer bg-transparent border-0 p-0 text-inherit font-[inherit] text-right"
      data-shown={s.shown ? 'true' : 'false'}
    >
      {/* Both layers occupy one grid cell so the width never jumps; opacity eases between them. */}
      <span aria-hidden="true" className={`[grid-area:1/1] text-text-secondary transition-opacity duration-300 ease-out ${s.shown ? 'opacity-0' : 'opacity-100'}`}>
        {PNL_PLACEHOLDER}
      </span>
      <span aria-hidden="true" className={`[grid-area:1/1] transition-opacity duration-300 ease-out ${className} ${s.shown ? 'opacity-100' : 'opacity-0'}`}>
        {s.shown ? value : ''}
      </span>
    </button>
  )
}
