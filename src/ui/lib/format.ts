// The single UI number/time module. Typographic minus (U+2212) throughout; the ASCII
// variants live in src/shared/format.ts for server text and the TUI. Chart-axis
// formatters stay local to their charts.

export const MINUS = '−'

const DASH = '—'

/** `2026-09-23 08:05 UTC`; the input back when it does not parse. */
export function fmtUtcStamp(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
}

export function fmtTs(iso: string | null | undefined): string {
  return iso ? fmtUtcStamp(iso) : DASH
}

export function fmtTsSec(iso: string | null | undefined): string {
  if (!iso) return DASH
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
}

/** A duration in seconds as fmtAge's words without `AGO`: `42S`, `3M`, `5H`, `2D`. */
export function fmtDur(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  if (s < 60) return `${s}S`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}M`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}H`
  return `${Math.floor(h / 24)}D`
}

export function fmtAge(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return DASH
  const ms = now - new Date(iso).getTime()
  if (Number.isNaN(ms)) return iso
  return `${fmtDur(ms / 1000)} AGO`
}

/** `+38bp`, `−5.4%`: sign + magnitude + unit. Zero (after rounding) carries no sign; null is a dash. */
export function fmtSigned(n: number | null | undefined, unit: string, dp = 0): string {
  if (n == null || !Number.isFinite(n)) return DASH
  const body = Math.abs(n).toFixed(dp)
  const sign = Number(body) === 0 ? '' : n > 0 ? '+' : MINUS
  return `${sign}${body}${unit}`
}

export const fmtUsd = (x: number) =>
  `${x < 0 ? MINUS : ''}$${Math.abs(x).toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`

export function fmtUsdSigned(n: number | null | undefined): string {
  if (n == null) return DASH
  const sign = n < 0 ? MINUS : n > 0 ? '+' : ''
  return `${sign}$${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 2 })}`
}

export function fmtUsdCompact(value: number): string {
  const sign = value < 0 ? '-' : ''
  return `${sign}$${new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(Math.abs(value))}`
}

export function fmtPx(x: number | null | undefined): string {
  if (x == null || !Number.isFinite(x)) return DASH
  const a = Math.abs(x)
  return a >= 1000 ? x.toLocaleString(undefined, { maximumFractionDigits: 1 }) : a >= 1 ? x.toFixed(3) : x.toPrecision(4)
}

/** Tailwind text class for a signed value; zero, null and NaN are neutral. */
export function signClass(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n === 0) return 'text-text-secondary'
  return n > 0 ? 'text-green' : 'text-red-text'
}
