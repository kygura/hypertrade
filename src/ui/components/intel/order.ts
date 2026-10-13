import type { OrderIntent, OrderPreview } from '../../../shared/intel'

// Pure helpers behind the order copilot view (DESIGN-terminal §7): venue
// mapping, the 60 s preview countdown, confirm gating and the single-flight
// guard on POST /order/confirm. Kept out of the components so tests can pin
// them without a DOM.

export type DeskVenue = 'paper' | 'testnet'

/** Desk venue strings (`paper`, `hl-testnet`) → the badge vocabulary; anything else is unknown. */
export function venueOf(v: string | null | undefined): DeskVenue | null {
  const s = v?.trim().toLowerCase()
  if (s === 'paper') return 'paper'
  if (s === 'hl-testnet' || s === 'testnet') return 'testnet'
  return null
}

export const VENUE_UNKNOWN = 'venue unknown — open DESK to check'
export const PREVIEW_TTL_MS = 60_000
export const PREVIEW_AMBER_MS = 15_000
export const STALE_TEXT = 'preview stale — marks moved or 60 s passed; re-preview before confirming'
/** Gap (DESIGN-terminal §7.4 names the state, not its copy): ADJUST edits mark the card stale. */
export const EDITED_TEXT = 'preview stale — order edited; re-preview before confirming'

/** Milliseconds left on a preview: 60 s from receipt, never past the server's expiresAt. */
export function previewRemainingMs(expiresAt: string, receivedAt: number, now: number): number {
  const local = receivedAt + PREVIEW_TTL_MS
  const server = Date.parse(expiresAt)
  // The server clock can drift from ours; only trust expiresAt when it is earlier than receipt + TTL
  // by less than the TTL itself (a wildly skewed clock would otherwise expire every preview at once).
  const end = Number.isFinite(server) && server < local && server > receivedAt ? server : local
  return Math.max(0, end - now)
}

/** `0:42` (tabular, whole seconds, rounded up so 0:00 means expired). */
export function fmtCountdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function confirmLabel(venue: DeskVenue | null): string {
  return venue === 'testnet' ? 'CONFIRM TESTNET ORDER' : 'CONFIRM PAPER ORDER'
}

export function placeLabel(venue: DeskVenue | null): string {
  return venue === 'testnet' ? 'PLACE TESTNET ORDER' : 'PLACE PAPER ORDER'
}

/**
 * Why CONFIRM is disabled, or null when it may open the dialog. Staleness is
 * handled by the caller (the button becomes RE-PREVIEW instead).
 */
export function confirmBlock(
  preview: Pick<OrderPreview, 'verdict' | 'venue'>,
  deskVenue: DeskVenue | null,
  venueError: string | null | undefined,
): string | null {
  if (preview.verdict.decision === 'reject') return 'governor rejected — adjust and re-preview'
  if (deskVenue == null) return venueError || VENUE_UNKNOWN
  if (venueOf(preview.venue) !== deskVenue) return VENUE_UNKNOWN
  return null
}

// ── formatting ──

const minus = (n: number) => (n < 0 ? '−' : '+')

export function fmtSignedPct(n: number, digits = 1): string {
  return `${minus(n)}${Math.abs(n).toFixed(digits)}%`
}

export function fmtPrice(x: number | null | undefined): string {
  if (x == null || !Number.isFinite(x)) return '—'
  const a = Math.abs(x)
  const body = a >= 1000 ? x.toLocaleString('en-US', { maximumFractionDigits: 1 }) : a >= 1 ? x.toFixed(3) : x.toPrecision(4)
  return `$${body}`
}

export function fmtUsd2(x: number): string {
  return `${x < 0 ? '−' : ''}$${Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export function fmtSize(x: number): string {
  return Number(x.toPrecision(6)).toString()
}

/** `−5.2%` from entry for a level (stop, liq), signed by direction. */
export function distFromEntry(px: number, entryPx: number): string {
  if (!(entryPx > 0)) return '—'
  return fmtSignedPct((px / entryPx - 1) * 100)
}

/** How the stop was resolved: the copilot's own `stop = …` note when present, else the intent's kind. */
export function stopResolution(intent: OrderIntent, notes: readonly string[] | undefined): string {
  const note = notes?.find((n) => n.startsWith('stop ='))
  if (note) return note.replace(/^stop = /, '')
  const s = intent.stop
  switch (s.type) {
    case 'price':
      return 'as given'
    case 'pct':
      return `${intent.side === 'long' ? '−' : '+'}${s.pct}% from entry`
    case 'prev_day_low':
      return 'prev-day low'
    case 'prev_day_high':
      return 'prev-day high'
    case 'atr_mult':
      return `${s.mult} × ATR14`
  }
}

/** The body of the Level 2 dialog: names everything (DESIGN-terminal §7.3). */
export function confirmBody(p: OrderPreview, venue: DeskVenue | null): string {
  const r = p.resolved
  const side = p.intent.side.toUpperCase()
  const at = p.intent.entry.type === 'limit' ? `limit ${fmtPrice(p.intent.entry.px)}` : 'market'
  const liq = r.liqPx != null ? `, liq ${fmtPrice(r.liqPx)}` : ''
  return (
    `${side} ${fmtSize(r.size)} ${p.intent.asset} (≈ ${fmtUsd2(r.notionalUsd)}) at ${at} on ${venue === 'testnet' ? 'TESTNET' : 'PAPER'}, ` +
    `stop ${fmtPrice(r.stopPx)}${liq}. Risks ${r.riskPct.toFixed(1)}% of the book (${fmtUsd2(r.riskUsd)}). Nothing goes to mainnet.`
  )
}

// ── single flight ──

/**
 * At most one confirm request at a time. `run` returns null (and does not
 * call `fn`) while a previous run is still pending, so a double click or a
 * re-render race can never send POST /order/confirm twice.
 */
export function createSingleFlight() {
  let pending: Promise<unknown> | null = null
  return {
    get busy() {
      return pending !== null
    },
    run<T>(fn: () => Promise<T>): Promise<T> | null {
      if (pending) return null
      const p = Promise.resolve().then(fn)
      pending = p
      const clear = () => {
        if (pending === p) pending = null
      }
      p.then(clear, clear)
      return p
    },
  }
}
