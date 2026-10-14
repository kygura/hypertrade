import { fmtUsd } from '../../../shared/format'
import type { FlowFlag, HeatmapMetric, HeatmapResponse, HeatmapWindow } from '../../../shared/intel'
import { fmtSigned, fmtUsdSigned } from './format'

// Pure helpers for the FLOW panel and the asset page (DESIGN-terminal §15).
// Detector code names never reach the screen: every chip and numbers line
// comes from here.

export type HeatGroup = 'snapshot' | 'flow'

/** Heatmap columns in the pinned order (§15.2): header, group, `title`. */
export const HEAT_COLUMNS: readonly { metric: HeatmapMetric; header: string; group: HeatGroup; title: string }[] = [
  { metric: 'price', header: 'PRICE', group: 'snapshot', title: 'price' },
  { metric: 'oi_usd', header: 'OI', group: 'snapshot', title: 'open interest (USD)' },
  { metric: 'funding', header: 'FUND', group: 'snapshot', title: 'hourly funding (level z)' },
  { metric: 'basis', header: 'BASIS', group: 'snapshot', title: 'mark vs oracle (level z)' },
  { metric: 'premium', header: 'PREM', group: 'snapshot', title: 'premium (level z)' },
  { metric: 'vol24h', header: 'VOL', group: 'snapshot', title: '24 h volume (ratio z)' },
  { metric: 'depth_2', header: 'DEPTH', group: 'snapshot', title: 'book depth ±2 %, bid + ask (ratio z)' },
  { metric: 'spread_bps', header: 'SPRD', group: 'snapshot', title: 'spread (ratio z)' },
  { metric: 'long_short_ratio', header: 'L/S', group: 'flow', title: 'long/short ratio' },
  { metric: 'liq_usd', header: 'LIQS', group: 'flow', title: 'liquidations, long + short (USD)' },
  { metric: 'perp_volume_usd', header: 'PERP', group: 'flow', title: 'perp volume (USD)' },
  { metric: 'spot_volume_usd', header: 'SPOT', group: 'flow', title: 'spot volume (USD)' },
]

export const FLOW_NO_SOURCE = 'no flow source configured — see docs/research/flow-sources.md'

/** The verbatim flow error, or the fallback for the bare `no_source` code. */
export function flowSourceText(flow: HeatmapResponse['flow']): string {
  return flow.error && flow.error !== 'no_source' ? flow.error : FLOW_NO_SOURCE
}

export type ZBucket = 'null' | 'zero' | 'pos1' | 'pos2' | 'neg1' | 'neg2'

/** Ramp bucket on z: |z| < 1 inside noise, 1–2, ≥ 2 (§15.2). */
export function zBucket(z: number | null | undefined): ZBucket {
  if (z == null || !Number.isFinite(z)) return 'null'
  if (z >= 2) return 'pos2'
  if (z >= 1) return 'pos1'
  if (z <= -2) return 'neg2'
  if (z <= -1) return 'neg1'
  return 'zero'
}

export const BUCKET_BG: Record<ZBucket, string> = {
  null: 'var(--color-panel-alt)',
  zero: 'var(--color-mom-zero)',
  pos1: 'var(--color-mom-pos1)',
  pos2: 'var(--color-mom-pos2)',
  neg1: 'var(--color-mom-neg1)',
  neg2: 'var(--color-mom-neg2)',
}

export const WINDOW_WORD: Record<HeatmapWindow, string> = { review: 'since review', '1h': '1h', '6h': '6h', '24h': '24h' }

const PCT = new Set<HeatmapMetric>(['price', 'oi_usd', 'vol24h', 'depth_2', 'spread_bps'])
const RATE = new Set<HeatmapMetric>(['funding', 'basis', 'premium'])
const USD = new Set<HeatmapMetric>(['liq_usd', 'perp_volume_usd', 'spot_volume_usd'])

/** A cell's Δ in its unit: log metrics in %, rates (fractions) in %, flows in USD, L/S raw. */
export function fmtHeatDelta(metric: HeatmapMetric, delta: number | null): string {
  if (delta == null) return '—'
  if (PCT.has(metric)) return fmtSigned(delta, 1, '%')
  if (RATE.has(metric)) return fmtSigned(delta * 100, 4, '%')
  if (USD.has(metric)) return fmtUsdSigned(delta, true)
  return fmtSigned(delta, 2)
}

export function cellTitle(asset: string, metric: HeatmapMetric, window: HeatmapWindow, z: number | null, delta: number | null): string {
  if (z == null) return window === 'review' ? 'fewer than 24 samples' : 'fewer than 48 samples'
  const name = HEAT_COLUMNS.find((c) => c.metric === metric)?.title ?? metric
  return `${asset} ${name} · ${WINDOW_WORD[window]} · Δ ${fmtHeatDelta(metric, delta)} · z ${fmtSigned(z, 1)}`
}

// ── detector copy (§15.3) ──

const DETECTOR_WORD: Record<string, string> = {
  crowded_long: 'CROWDED LONG',
  crowded_short: 'CROWDED SHORT',
  squeeze_setup: 'SQUEEZE SETUP',
  negative_funding_oi_build: 'SQUEEZE SETUP',
  deleveraging: 'DELEVERAGING',
  spot_led: 'SPOT LED',
  perp_led: 'PERP LED',
  liquidity_thinning: 'THIN BOOK',
  oi_up_price_down: 'OI UP, PRICE DOWN',
}

const hourlyPct = (f: number, d = 4) => fmtSigned(f * 100, d, '%')
const per8h = (f: number) => `${(f * 8 * 100).toFixed(3).replace(/\.?0+$/, '')}%/8H`
const bp = (f: number) => fmtSigned(f * 1e4, 1, ' bp')
const zOf = (label: string, z: number | undefined) => (z == null ? null : `${label} z ${fmtSigned(z, 1)}`)
const join = (parts: (string | null)[]) => parts.filter(Boolean).join(' · ')

/** `funding>0.0000625` → {metric, op, value}; null when the name is not a crossing. */
function parseCrossing(name: string): { metric: string; op: string; value: number } | null {
  const m = /^([a-z0-9_]+)([<>])(\S+)$/.exec(name)
  return m && Number.isFinite(Number(m[3])) ? { metric: m[1]!, op: m[2]!, value: Number(m[3]) } : null
}

/** Plain-word chip text without asset/window: `CROWDED LONG`, `FUNDING FLIPPED +`, `FUNDING > 0.05%/8H`. */
export function flagWord(f: Pick<FlowFlag, 'kind' | 'name' | 'numbers'>): string {
  const n = f.numbers
  if (f.name === 'funding_flip') return `FUNDING FLIPPED ${(n.to ?? 0) >= 0 ? '+' : '−'}`
  if (f.name === 'basis_flip') return (n.to ?? 0) < 0 ? 'BASIS INVERTED' : 'BASIS BACK ABOVE 0'
  if (f.kind === 'crossing') {
    const c = parseCrossing(f.name)
    if (c) return `${c.metric.replace(/_/g, ' ').toUpperCase()} ${c.op} ${c.metric === 'funding' ? per8h(c.value) : c.value}`
  }
  return DETECTOR_WORD[f.name] ?? f.name.replace(/_/g, ' ').toUpperCase()
}

/** The numbers line, printed from the detector's own values (signs always, no color). */
export function numbersLine(f: Pick<FlowFlag, 'kind' | 'name' | 'numbers' | 'window'>): string {
  const n = f.numbers
  switch (f.name) {
    case 'crowded_long':
    case 'crowded_short':
      return join([zOf('funding', n.funding_z), zOf('OI 24h', n.oi_z_24h), zOf('price 24h', n.price_z_24h)])
    case 'squeeze_setup':
    case 'negative_funding_oi_build':
      return join([n.funding == null ? null : `funding ${hourlyPct(n.funding)}`, zOf('OI 24h', n.oi_z_24h), zOf('price 24h', n.price_z_24h)])
    case 'deleveraging':
      return join([n.oi_pct_6h == null ? null : `OI 6h ${fmtSigned(n.oi_pct_6h, 1, '%')}`, zOf('liqs 6h', n.liq_z_6h)])
    case 'spot_led':
    case 'perp_led':
      return join([zOf('price 6h', n.price_z_6h), n.gap == null ? null : `spot/perp vol z gap ${fmtSigned(n.gap, 1)}`])
    case 'liquidity_thinning':
      return join([
        n.depth_2 == null ? null : `depth ±2% ${fmtUsd(n.depth_2, { compact: true })}`,
        n.p10 == null ? null : `30d p10 ${fmtUsd(n.p10, { compact: true })}`,
      ])
    case 'funding_flip':
      return n.from == null || n.to == null ? '' : `${hourlyPct(n.from, 3)} → ${hourlyPct(n.to, 3)}`
    case 'basis_flip':
      return n.from == null || n.to == null ? '' : `${bp(n.from)} → ${bp(n.to)}`
    case 'oi_up_price_down':
      return join([zOf(`OI ${f.window}`, n.oi_z), zOf(`price ${f.window}`, n.price_z)])
  }
  if (f.kind === 'crossing' && n.to != null) {
    const c = parseCrossing(f.name)
    return c?.metric === 'funding' ? `now ${per8h(n.to).replace('/8H', '/8h')}` : `now ${n.to}`
  }
  return Object.entries(n)
    .map(([k, v]) => `${k.replace(/_/g, ' ')} ${fmtSigned(v, 2)}`)
    .join(' · ')
}

/** `CROWDED LONG · HYPE 24H`. */
export function chipText(f: FlowFlag): string {
  return `${flagWord(f)} · ${f.asset} ${f.window.toUpperCase()}`
}

/**
 * Firing chips: one per (name, asset), newest kept, ordered by the row's
 * materiality then newest ts. Degraded flags are not firing (see degradedChips).
 */
export function firingChips(flags: FlowFlag[], materiality: Map<string, number>): FlowFlag[] {
  const best = new Map<string, FlowFlag>()
  for (const f of flags) {
    if (f.degraded) continue
    const k = `${f.name}:${f.asset}`
    const cur = best.get(k)
    if (!cur || f.ts > cur.ts) best.set(k, f)
  }
  return [...best.values()].sort((a, b) => (materiality.get(b.asset) ?? 0) - (materiality.get(a.asset) ?? 0) || b.ts.localeCompare(a.ts))
}

export interface DegradedChip {
  key: string
  text: string
  /** Why it cannot fire, plus the assets it covers. */
  reason: string
}

const DEGRADED_COPY: Record<string, { key: string; text: string; reason: string }> = {
  deleveraging: { key: 'deleveraging', text: 'DELEVERAGING · NO LIQ DATA', reason: 'no liquidation data, or too few samples for its z' },
  spot_led: { key: 'spot_perp', text: 'SPOT/PERP LED · NO SPOT DATA', reason: 'no spot volume data, or too few samples for its z' },
  perp_led: { key: 'spot_perp', text: 'SPOT/PERP LED · NO SPOT DATA', reason: 'no spot volume data, or too few samples for its z' },
}

/** One summary chip per degraded detector (not per asset): visibly "cannot fire", never "did not fire". */
export function degradedChips(flags: FlowFlag[]): DegradedChip[] {
  const out = new Map<string, DegradedChip & { assets: Set<string> }>()
  for (const f of flags) {
    if (!f.degraded) continue
    const copy = DEGRADED_COPY[f.name] ?? { key: f.name, text: `${flagWord(f)} · TOO LITTLE DATA`, reason: 'a series it needs is missing or too short' }
    const cur = out.get(copy.key) ?? { ...copy, assets: new Set<string>() }
    cur.assets.add(f.asset)
    out.set(copy.key, cur)
  }
  return [...out.values()].map(({ assets, ...c }) => ({ ...c, reason: `${c.reason} — outcome unknown (${[...assets].join(', ')})` }))
}
