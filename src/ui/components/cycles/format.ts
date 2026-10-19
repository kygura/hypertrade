import type { CyclePhase } from '../../../shared/cycles'

// Shared helpers for the /cycles view. Dates are UTC: cycle anchors are
// whole UTC days and must not shift a month under a local timezone.

export const PHASE_LABEL: Record<CyclePhase, string> = {
  accumulation: 'ACCUMULATION',
  expansion: 'EXPANSION',
  euphoria: 'EUPHORIA',
  distribution: 'DISTRIBUTION',
  markdown: 'MARKDOWN',
  capitulation: 'CAPITULATION',
}

/**
 * Phase colour tokens, spelled out in full: Tailwind only emits @theme
 * variables it finds referenced in source, so a name built at runtime would
 * resolve to nothing.
 */
export const PHASE_VAR: Record<CyclePhase, string> = {
  accumulation: '--color-ph-accumulation',
  expansion: '--color-ph-expansion',
  euphoria: '--color-ph-euphoria',
  distribution: '--color-ph-distribution',
  markdown: '--color-ph-markdown',
  capitulation: '--color-ph-capitulation',
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function fmtMonth(ms: number): string {
  const d = new Date(ms)
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`
}

export function fmtDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

export function fmtQuarter(ms: number): string {
  const d = new Date(ms)
  return `Q${Math.floor(d.getUTCMonth() / 3) + 1} ${d.getUTCFullYear()}`
}

/** USD price: whole dollars from $1,000, cents below (2011 traded at $2-30). */
export function fmtUsdPx(n: number): string {
  if (!Number.isFinite(n)) return '--'
  return '$' + n.toLocaleString('en-US', { maximumFractionDigits: n >= 1000 ? 0 : 2, minimumFractionDigits: n >= 1000 ? 0 : 2 })
}

export function fmtDays(n: number): string {
  return `${n < 0 ? '−' : ''}${Math.abs(n).toLocaleString('en-US')}d`
}

export function css(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

function rgb(color: string): [number, number, number] | null {
  if (color.startsWith('#') && color.length === 7) {
    const n = parseInt(color.slice(1), 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  }
  const m = /rgba?\(([^)]+)\)/.exec(color)
  if (!m) return null
  const [r, g, b] = m[1]!.split(',').map((x) => Number(x.trim()))
  return [r!, g!, b!]
}

/**
 * `color` at opacity `a` over `base`, as an opaque colour. Full-history
 * charts pack several daily bars into one pixel; translucent bars would
 * stack their alpha there and read far stronger than intended.
 */
export function blend(color: string, base: string, a: number): string {
  const c = rgb(color)
  const b = rgb(base)
  if (!c || !b) return alpha(color, a)
  const mix = (i: number) => Math.round(b[i]! + (c[i]! - b[i]!) * a)
  return `rgb(${mix(0)},${mix(1)},${mix(2)})`
}

/** Scales a hex or rgb(a) color's opacity by `a` (theme tokens may already carry alpha). */
export function alpha(color: string, a: number): string {
  if (color.startsWith('#') && color.length === 7) {
    const n = parseInt(color.slice(1), 16)
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`
  }
  const m = /rgba?\(([^)]+)\)/.exec(color)
  if (m) {
    const [r, g, b, a0] = m[1]!.split(',').map((x) => x.trim())
    return `rgba(${r},${g},${b},${(a0 == null ? 1 : Number(a0)) * a})`
  }
  return color
}
