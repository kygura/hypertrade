import type { GaugeKey, RegimeState, VectorResponse } from '../../../shared/vector'

// Display constants and pure helpers for /vector (ported from hl-cycles
// components/vector/scales.ts + tokens.ts, DESIGN §14.3/§14.4.2). Zone edges
// mirror the hl-cycles model thresholds (docs/MODEL.md §8 there); gauge
// min/max come from the API (`gauges.<key>.scale`).

export const DAY_MS = 86_400_000

export const REGIME_STATES: readonly RegimeState[] = ['strong_risk_off', 'mild_risk_off', 'mild_risk_on', 'strong_risk_on']

/**
 * Regime colour tokens, spelled out in full: Tailwind only emits @theme
 * variables it finds referenced in source.
 */
export const REGIME_VAR: Record<RegimeState, string> = {
  strong_risk_off: '--color-regime-strong-off',
  mild_risk_off: '--color-regime-mild-off',
  mild_risk_on: '--color-regime-mild-on',
  strong_risk_on: '--color-regime-strong-on',
}

export const REGIME_WORD: Record<RegimeState, string> = {
  strong_risk_off: 'STRONG RISK-OFF',
  mild_risk_off: 'MILD RISK-OFF',
  mild_risk_on: 'MILD RISK-ON',
  strong_risk_on: 'STRONG RISK-ON',
}

export const regimeColor = (s: RegimeState | null): string => (s ? `var(${REGIME_VAR[s]})` : 'var(--color-text-secondary)')

/** Compass band ramp, lowest → highest (scores 0–20 … 80–100): reds, grey, blues. */
const BAND = [
  'var(--color-regime-strong-off)',
  'var(--color-regime-mild-off)',
  'var(--color-band-mid)',
  'var(--color-regime-mild-on)',
  'var(--color-regime-strong-on)',
] as const

/** Bands are fixed at 20/40/60/80: score → band index 1..5 (100 → 5). */
export function bandIndex(score: number): 1 | 2 | 3 | 4 | 5 {
  return Math.min(5, Math.max(1, Math.floor(score / 20) + 1)) as 1 | 2 | 3 | 4 | 5
}
export const bandColor = (score: number): string => BAND[bandIndex(score) - 1]

export type GaugeZone = { to: number; color: string; word: string }

export const GAUGE_KEYS: readonly GaugeKey[] = ['risk', 'momentum', 'fundamentals', 'flows']

export const GAUGE_LABEL: Record<GaugeKey, string> = {
  risk: 'RISK',
  momentum: 'MOMENTUM',
  fundamentals: 'FUNDAMENTALS',
  flows: 'FLOWS',
}

// Zones use the mild colours only: the gauges are evidence, not four more verdicts.
export const GAUGE_ZONES: Record<GaugeKey, GaugeZone[]> = {
  // riskOff × 100; state rule edges 0.25 / 0.5.
  risk: [
    { to: 25, color: BAND[3], word: 'low risk' },
    { to: 50, color: BAND[2], word: 'elevated' },
    { to: 100, color: BAND[1], word: 'high risk' },
  ],
  // Sign only.
  momentum: [
    { to: 0, color: BAND[1], word: 'bearish' },
    { to: 100, color: BAND[3], word: 'bullish' },
  ],
  // Compass band edges. Fundamentals and flows words are replaced by the matching
  // lens band at render time so gauge and tile agree; these are the fallback.
  fundamentals: [
    { to: 40, color: BAND[1], word: 'weak' },
    { to: 60, color: BAND[2], word: 'neutral' },
    { to: 100, color: BAND[3], word: 'strong' },
  ],
  flows: [
    { to: 40, color: BAND[1], word: 'outflow' },
    { to: 60, color: BAND[2], word: 'flat' },
    { to: 100, color: BAND[3], word: 'inflow' },
  ],
}

export function zoneFor(zones: GaugeZone[], v: number): GaugeZone {
  return zones.find((z) => v <= z.to) ?? zones[zones.length - 1]!
}

/**
 * Angle on the gauge's upper semicircle for value `v`: π at `min` (left), 0 at
 * `max` (right). Out-of-domain values pin to the arc end.
 */
export function gaugeAngle(v: number, min: number, max: number): number {
  if (!(max > min)) return Math.PI / 2
  const c = Math.min(max, Math.max(min, v))
  return Math.PI * (1 - (c - min) / (max - min))
}

/** `›` / `‹` when the true value lies past the gauge's domain (the marker is pinned). */
export function overflowMark(v: number, min: number, max: number): string {
  return v > max ? '›' : v < min ? '‹' : ''
}

/** A lens input older than its lens' freshest input by more than this is flagged. */
export const INPUT_STALE_MS = 7 * DAY_MS
/** The payload moves once a day; past this age it is shown stale even if the server says fresh. */
export const VECTOR_STALE_MS = 3 * DAY_MS

/** Stale when the server says so or `asOf` is older than three days. */
export function isVectorStale(v: Pick<VectorResponse, 'stale' | 'asOf'>, now: number): boolean {
  return v.stale || (v.asOf != null && now - v.asOf > VECTOR_STALE_MS)
}

/**
 * Where the live-price divider goes in a level ladder sorted high → low: the
 * index of the first level below price (or without a value); -1 when every level
 * is above price, or price is unknown (the caller then appends or omits it).
 */
export function priceDividerIndex(sortedValues: (number | null)[], price: number | null): number {
  if (price == null) return -1
  return sortedValues.findIndex((v) => v == null || v < price)
}
