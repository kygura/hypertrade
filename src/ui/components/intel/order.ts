import { fmtPrice as fmtPriceRaw, fmtUsd } from '../../../shared/format'
import type { OrderIntent, OrderPreview } from '../../../shared/intel'
import { fmtSigned, MINUS } from './format'

// Pure helpers behind the order copilot view (DESIGN-terminal §7): venue
// mapping, the 60 s preview countdown, confirm gating and the single-flight
// guard on POST /order/confirm. Kept out of the components so tests can pin
// them without a DOM.

export type DeskVenue = 'paper' | 'testnet' | 'propr'

/** Desk venue strings (`paper`, `hl-testnet`, `propr`) → the badge vocabulary; anything else is unknown. */
export function venueOf(v: string | null | undefined): DeskVenue | null {
  const s = v?.trim().toLowerCase()
  if (s === 'paper') return 'paper'
  if (s === 'hl-testnet' || s === 'testnet') return 'testnet'
  if (s === 'propr') return 'propr'
  return null
}

/** The venue as one upper-case word for labels. */
export function venueWord(v: DeskVenue | null): string {
  return v === 'testnet' ? 'TESTNET' : v === 'propr' ? 'PROPR' : 'PAPER'
}

export const VENUE_UNKNOWN = 'venue unknown — open DESK to check'
const PREVIEW_TTL_MS = 60_000
export const STALE_TEXT = 'preview stale — marks moved or 60 s passed; re-preview before confirming'
/** Gap (DESIGN-terminal §7.4 names the state, not its copy): ADJUST edits mark the card stale. */
export const EDITED_TEXT = 'preview stale — order edited; re-preview before confirming'

/** When a preview stops being confirmable (ms epoch): 60 s from receipt, never past the server's expiresAt. */
export function previewValidUntil(expiresAt: string, receivedAt: number): number {
  const local = receivedAt + PREVIEW_TTL_MS
  const server = Date.parse(expiresAt)
  // The server clock can drift from ours; only trust expiresAt when it is earlier than receipt + TTL
  // by less than the TTL itself (a wildly skewed clock would otherwise expire every preview at once).
  return Number.isFinite(server) && server < local && server > receivedAt ? server : local
}

/** Milliseconds left on a preview (0 once expired). */
export function previewRemainingMs(expiresAt: string, receivedAt: number, now: number): number {
  return Math.max(0, previewValidUntil(expiresAt, receivedAt) - now)
}

/**
 * Calm, static validity copy: `valid until 14:05:42` (local clock). No ticking countdown: the
 * window is 60 s, so seconds are kept to say exactly when it ends.
 */
export function fmtPreviewUntil(endMs: number): string {
  return `valid until ${new Date(endMs).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}`
}

export function confirmLabel(venue: DeskVenue | null): string {
  return `CONFIRM ${venueWord(venue)} ORDER`
}

export function placeLabel(venue: DeskVenue | null): string {
  return `PLACE ${venueWord(venue)} ORDER`
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

// ── formatting (shared/format.ts underneath) ──

/** `$3,412.5`, `$3.412`, `$0.01234` (1 decimal ≥ 1000, 3 under; shared default below 1). */
export function fmtPrice(x: number | null | undefined): string {
  if (x == null || !Number.isFinite(x)) return '—'
  const a = Math.abs(x)
  return `$${fmtPriceRaw(x, a >= 1000 ? 1 : a >= 1 ? 3 : undefined)}`
}

/** `$1,512.00`; negative with U+2212. */
export function fmtUsd2(x: number): string {
  return `${x < 0 ? MINUS : ''}${fmtUsd(Math.abs(x))}`
}

export function fmtSize(x: number): string {
  return Number(x.toPrecision(6)).toString()
}

/** `−5.2%` from entry for a level (stop, liq), signed by direction. */
export function distFromEntry(px: number, entryPx: number): string {
  if (!(entryPx > 0)) return '—'
  return fmtSigned((px / entryPx - 1) * 100, 1, '%')
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
      return `${intent.side === 'long' ? MINUS : '+'}${s.pct}% from entry`
    case 'prev_day_low':
      return 'prev-day low'
    case 'prev_day_high':
      return 'prev-day high'
    case 'atr_mult':
      return `${s.mult} × ATR14`
  }
}

/**
 * One fact line under the preview headline: what a stop-out costs and how far the stop, the
 * estimated liquidation and the target sit from entry. Numbers are the order as resolved,
 * before any governor clip.
 */
export function previewTakeaway(p: Pick<OrderPreview, 'intent' | 'resolved'>): string {
  const r = p.resolved
  const dist = (px: number) => (r.entryPx > 0 ? Math.abs(px / r.entryPx - 1) * 100 : null)
  const pct = (x: number) => `${x.toFixed(1)}%`
  const out = [`A fill at the stop ${fmtPrice(r.stopPx)} loses ${fmtUsd2(r.riskUsd)}, ${pct(r.riskPct)} of the book, before fees.`]
  const stopDist = dist(r.stopPx)
  if (stopDist != null) {
    const liqDist = r.liqPx != null ? dist(r.liqPx) : null
    out.push(`Stop is ${pct(stopDist)} from entry` + (liqDist != null ? `, estimated liquidation ${pct(liqDist)}.` : '; no liquidation estimate.'))
    if (p.intent.target == null) out.push('No target given.')
    else {
      const targetDist = dist(p.intent.target)!
      out.push(`Target is ${pct(targetDist)} from entry` + (stopDist > 0 ? `, ${(targetDist / stopDist).toFixed(1)} times the stop distance.` : '.'))
    }
  }
  return out.join(' ')
}

/** The body of the Level 2 dialog: names everything and reads as irreversible (DESIGN-terminal §7.1 item 4, §7.3). */
export function confirmBody(p: OrderPreview, venue: DeskVenue | null): string {
  const r = p.resolved
  const side = p.intent.side.toUpperCase()
  const at = p.intent.entry.type === 'limit' ? `limit ${fmtPrice(p.intent.entry.px)}` : 'market'
  const liq = r.liqPx != null ? `, liq ${fmtPrice(r.liqPx)}` : ''
  const v = venueWord(venue)
  // Propr routes to Hyperliquid mainnet through the challenge account (a dry run unless PROPR_LIVE is on); the others never do.
  const where = venue === 'propr' ? 'On Propr it trades the challenge account on Hyperliquid mainnet, or is a dry run unless PROPR_LIVE is on.' : 'Nothing goes to mainnet.'
  return (
    `${side} ${fmtSize(r.size)} ${p.intent.asset} (≈ ${fmtUsd2(r.notionalUsd)}) at ${at} on ${v}, ` +
    `stop ${fmtPrice(r.stopPx)}${liq}. Risks ${r.riskPct.toFixed(1)}% of the book (${fmtUsd2(r.riskUsd)}). ${where} ` +
    `This places the order on ${v} now and can't be undone.`
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
