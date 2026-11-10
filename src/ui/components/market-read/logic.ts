import type { FundingPoint, PredictedFunding } from '../../../shared/hl-client'
import { VENUE_NAME, venueApr } from '../../../shared/marketRead'
import { SIGNAL } from '../../../shared/signals'
import type { AssetCtx } from '../../../shared/types'

// Pure shaping for the landing page panels (src/ui/pages/Market.tsx). Inputs are the
// live HL universe from useLiveUniverse; nothing here fetches or reads the clock.

const HOUR = 3_600_000
const HOURS_PER_YEAR = 24 * 365

export const oiUsd = (c: AssetCtx) => c.openInterest * c.markPx
export const aprPct = (hourly: number) => hourly * HOURS_PER_YEAR * 100

/** The universe every list reads: live, OI and 24h volume at or above the $1M floors. */
export function floorUniverse(ctxs: AssetCtx[]): AssetCtx[] {
  return ctxs.filter((c) => !c.isDelisted && c.markPx > 0 && oiUsd(c) >= SIGNAL.minOiUsd && c.dayNtlVlm >= SIGNAL.minVolUsd)
}

/** Largest `n` by open interest in USD. */
export function topByOi(ctxs: AssetCtx[], n: number): AssetCtx[] {
  return [...ctxs].sort((a, b) => oiUsd(b) - oiUsd(a)).slice(0, n)
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

export interface CexApr {
  venue: string
  aprPct: number
}

/** Binance's predicted funding as APR %, else Bybit's, each normalised by its own interval. */
export function cexApr(predicted: PredictedFunding[] | undefined): CexApr | null {
  const p = predicted?.find((x) => x.venue === 'BinPerp') ?? predicted?.find((x) => x.venue === 'BybitPerp')
  return p ? { venue: VENUE_NAME[p.venue] ?? p.venue, aprPct: venueApr(p) * 100 } : null
}

export interface FundingRow {
  coin: string
  aprPct: number
  cex: CexApr | null
}

/** The `n` hottest and `n` coldest coins by funding APR, with the CEX comparison. */
export function fundingBoard(ctxs: AssetCtx[], predicted: Map<string, PredictedFunding[]>, n = 5): { hot: FundingRow[]; cold: FundingRow[] } {
  const rows = ctxs.map((c) => ({ coin: c.name, aprPct: aprPct(c.funding), cex: cexApr(predicted.get(c.name)) }))
  const sorted = [...rows].sort((a, b) => b.aprPct - a.aprPct)
  const hot = sorted.slice(0, n)
  const cold = sorted.slice(Math.max(n, sorted.length - n)).reverse()
  return { hot, cold }
}

export interface PremiumRow {
  coin: string
  bp: number
}

/** The `n` largest |premium| in basis points. */
export function premiumBoard(ctxs: AssetCtx[], n = 5): PremiumRow[] {
  return ctxs
    .map((c) => ({ coin: c.name, bp: c.premium * 1e4 }))
    .sort((a, b) => Math.abs(b.bp) - Math.abs(a.bp))
    .slice(0, n)
}

export interface MoverRow {
  coin: string
  changePct: number
  /** 24h notional volume over the median of the top 50 by OI. */
  volX: number
}

/** Top and bottom `n` by 24h change; volume as a multiple of the top-50 median. */
export function movers(ctxs: AssetCtx[], n = 5): { up: MoverRow[]; down: MoverRow[] } {
  const medVol = median(topByOi(ctxs, 50).map((c) => c.dayNtlVlm))
  const rows = ctxs.map((c) => ({ coin: c.name, changePct: c.dayChange * 100, volX: medVol > 0 ? c.dayNtlVlm / medVol : 0 }))
  const sorted = [...rows].sort((a, b) => b.changePct - a.changePct)
  return {
    up: sorted.slice(0, n).filter((r) => r.changePct > 0),
    down: sorted
      .slice(Math.max(n, sorted.length - n))
      .reverse()
      .filter((r) => r.changePct < 0),
  }
}

export interface HeatRow {
  coin: string
  /** Current hourly funding, annualised (row order). */
  aprNow: number
  /** One annualised settlement per column, null where none landed. */
  cells: (number | null)[]
}

export interface HeatGrid {
  /** Start of each hourly column (ms), oldest first. */
  cols: number[]
  rows: HeatRow[]
}

/** Coin × hour grid of annualised funding over the last `hours` settlements, rows by current APR (hottest first). */
export function heatGrid(ctxs: AssetCtx[], data: Map<string, FundingPoint[]>, now: number, hours = 72): HeatGrid {
  const last = Math.floor(now / HOUR) * HOUR
  const cols = Array.from({ length: hours }, (_, i) => last - (hours - 1 - i) * HOUR)
  const first = cols[0]!
  const rows: HeatRow[] = []
  for (const c of ctxs) {
    const points = data.get(c.name)
    if (!points) continue
    const cells: (number | null)[] = Array.from({ length: hours }, () => null)
    for (const p of points) {
      const i = Math.floor((p.t - first) / HOUR)
      if (i >= 0 && i < hours) cells[i] = aprPct(p.rate)
    }
    rows.push({ coin: c.name, aprNow: aprPct(c.funding), cells })
  }
  rows.sort((a, b) => b.aprNow - a.aprNow)
  return { cols, rows }
}

const clip = (x: number, cap: number) => Math.max(-cap, Math.min(cap, x))

/** HL's default funding (0.00125%/h, the interest component) annualised: what a perp pays when it tracks spot. */
export const BASELINE_APR = 10.95
const HEAT_CAP = 60

/**
 * Heatmap fill, diverging around HL's baseline funding rather than zero, so the usual +11% reads as
 * neutral: warm (amber) = longs paying above baseline, cool (info) = below it. Square-root scale so
 * moderate departures are visible; clipped at ±60 pts. Tokens only.
 */
export function heatColor(apr: number | null): string {
  if (apr == null) return 'transparent'
  const d = clip(apr - BASELINE_APR, HEAT_CAP)
  const t = Math.sqrt(Math.abs(d) / HEAT_CAP)
  if (t < 0.15) return 'var(--color-elevated)'
  const pct = Math.round(10 + t * 85)
  return `color-mix(in srgb, var(${d > 0 ? '--color-amber' : '--color-info'}) ${pct}%, var(--color-elevated))`
}

/** OI map fill: green up, red down, diverging and capped at ±10% 24h change. Tokens only. */
export function changeColor(changePct: number): string {
  const t = Math.abs(clip(changePct, 10)) / 10
  if (t < 0.01) return 'var(--color-elevated)'
  const pct = Math.round(15 + t * 70)
  return `color-mix(in srgb, var(${changePct > 0 ? '--color-green' : '--color-red'}) ${pct}%, var(--color-elevated))`
}

/** "updated 12s ago" / "updated 3m ago". */
export function ageText(updatedAt: number | null, now: number): string {
  if (updatedAt == null) return 'connecting'
  const s = Math.max(0, Math.round((now - updatedAt) / 1000))
  return s < 120 ? `updated ${s}s ago` : `updated ${Math.round(s / 60)}m ago`
}

/** Signed whole percent: "+42%", "-8%", "0%". */
export function pct0(x: number): string {
  const r = Math.round(x)
  return `${r > 0 ? '+' : r < 0 ? '-' : ''}${Math.abs(r)}%`
}
