import { MINUS, fmtSigned } from '../../lib/format'
import { fmtDay, fmtUsdPx } from '../cycles/format'

// Number formats for /vector (hl-cycles DESIGN §14.6), on top of the shared UI
// helpers. Nulls print an em dash.

const DASH = '—'

/** UTC day, or a dash. */
export const fmtDate = (t: number | null | undefined): string => (t == null ? DASH : fmtDay(t))

/** USD price, or a dash. */
export const fmtPrice = (x: number | null | undefined): string => (x == null || !Number.isFinite(x) ? DASH : fmtUsdPx(x))

/** Unsigned-looking integer (compass score, 0–100 gauge values); negatives keep a typographic minus. */
export function fmtInt(x: number | null | undefined): string {
  if (x == null || !Number.isFinite(x)) return DASH
  const v = Math.round(x)
  return (v < 0 ? MINUS : '') + Math.abs(v)
}

/** Signed integer, no unit (compass d7/d30, momentum). Zero prints as `0`. */
export const fmtDeltaPts = (x: number | null | undefined): string => fmtSigned(x, '', 0)

/** Percent points (4.25 = 4.25%) → `4.25%`. */
export function fmtYield(x: number | null | undefined): string {
  if (x == null || !Number.isFinite(x)) return DASH
  return (x < 0 ? MINUS : '') + Math.abs(x).toFixed(2) + '%'
}

/** Raw lens input: at most 4 significant digits, thousands separators from 1,000. */
export function fmtRaw(x: number | null | undefined): string {
  if (x == null || !Number.isFinite(x)) return DASH
  const abs = Math.abs(x)
  const body = abs >= 1000 ? Math.round(abs).toLocaleString('en-US') : String(Number(abs.toPrecision(4)))
  return (x < 0 ? MINUS : '') + body
}

/** Whole UTC days from `from` to `to` (day 0 on the flip day). */
export const daysBetween = (from: number, to: number): number => Math.floor((to - from) / 86_400_000)

/** The theme's label look (uppercase eyebrow), as MetricStat and the state blocks use it. */
export const LABEL = 'text-xs text-text-secondary [text-transform:var(--label-case)] tracking-[var(--label-tracking)] font-[number:var(--label-weight)]'
