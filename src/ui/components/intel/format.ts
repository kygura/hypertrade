import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { fmtPct, fmtPrice, fmtUsd } from '../../../shared/format'
import type { DiffItem, SnapshotMetric } from '../../../shared/intel'

// Small helpers shared by the TERMINAL panels (DESIGN-terminal §3). Signs use
// U+2212 for minus, like the spec's examples; every computed number prints
// its sign (§11 "color never alone").

export const MINUS = '−'

export function fmtSigned(n: number, decimals = 1, suffix = ''): string {
  if (!Number.isFinite(n)) return '—'
  const sign = n > 0 ? '+' : n < 0 ? MINUS : ''
  return `${sign}${Math.abs(n).toFixed(decimals)}${suffix}`
}

/** DiffTable METRIC display names (§3.4). Depth keeps its side so bid and ask rows stay apart. */
export const METRIC_LABEL: Record<SnapshotMetric, string> = {
  price: 'price',
  oi_usd: 'OI',
  funding: 'funding',
  premium: 'premium',
  basis: 'basis',
  vol24h: 'vol 24h',
  depth_bid_1: 'depth ±1% bid',
  depth_ask_1: 'depth ±1% ask',
  depth_bid_2: 'depth ±2% bid',
  depth_ask_2: 'depth ±2% ask',
  spread_bps: 'spread',
}

const RATE_METRICS = new Set<SnapshotMetric>(['funding', 'premium', 'basis'])
const USD_METRICS = new Set<SnapshotMetric>(['oi_usd', 'vol24h', 'depth_bid_1', 'depth_ask_1', 'depth_bid_2', 'depth_ask_2'])

/**
 * Signed change in the metric's unit: `+18.4%`, `+0.0125%`, `+2.1 bp`, `+$1.20K`.
 * Rate metrics (funding, premium, basis) arrive in bp of a fraction but print
 * as % with 4 decimals, like their NOW/BASE levels (fmtMetricValue): an hourly
 * funding move is a few hundredths of a bp, which "+0.0 bp" would hide.
 */
export function fmtDelta(item: Pick<DiffItem, 'metric' | 'delta' | 'deltaUnit'>): string {
  const d = item.delta
  if (!Number.isFinite(d)) return '—'
  switch (item.deltaUnit) {
    case 'pct':
      return fmtSigned(d, 1, '%')
    case 'bps':
      return RATE_METRICS.has(item.metric) ? fmtSigned(d / 100, 4, '%') : fmtSigned(d, 1, ' bp')
    case 'usd':
      return `${d > 0 ? '+' : d < 0 ? MINUS : ''}${fmtUsd(Math.abs(d), { compact: true })}`
    case 'abs':
      // Rates are fractions (0.00012 = 0.012%).
      if (RATE_METRICS.has(item.metric)) return fmtSigned(d * 100, 3, '%')
      return fmtSigned(d, Math.abs(d) >= 100 ? 0 : 2)
  }
}

/** A metric's level, compact (NOW / BASE columns). */
export function fmtMetricValue(metric: SnapshotMetric, v: number): string {
  if (!Number.isFinite(v)) return '—'
  if (metric === 'price') return fmtPrice(v)
  if (USD_METRICS.has(metric)) return fmtUsd(v, { compact: true })
  if (RATE_METRICS.has(metric)) return fmtPct(v, { decimals: 4 })
  return `${v.toFixed(1)} bp`
}

/** Distance to stop as `−3.1% · 0.8×ATR` (ATR part only when known), `—` without a stop. */
export function fmtStopDist(pct: number | null | undefined, atr?: number | null): string {
  if (pct == null || !Number.isFinite(pct)) return '—'
  const head = `${MINUS}${Math.abs(pct).toFixed(1)}%`
  return atr != null && Number.isFinite(atr) ? `${head} · ${atr.toFixed(1)}×ATR` : head
}

/** Countdown to `ts`: `T−1D 04H`, `T−4H 12M`, `T−42M`; just past reads `T+12M`. */
export function fmtCountdown(ts: string, now = Date.now()): string {
  const ms = new Date(ts).getTime() - now
  if (!Number.isFinite(ms)) return '—'
  const mins = Math.floor(Math.abs(ms) / 60_000)
  if (ms < 0) return `T+${mins}M`
  const d = Math.floor(mins / 1440)
  const h = Math.floor((mins % 1440) / 60)
  const m = mins % 60
  if (d > 0) return `T${MINUS}${d}D ${String(h).padStart(2, '0')}H`
  if (h > 0) return `T${MINUS}${h}H ${String(m).padStart(2, '0')}M`
  return `T${MINUS}${m}M`
}

export function hoursUntil(ts: string, now = Date.now()): number {
  return (new Date(ts).getTime() - now) / 3_600_000
}

export function hoursSince(ts: string, now = Date.now()): number {
  return (now - new Date(ts).getTime()) / 3_600_000
}

/** `9 hours ago` / `40 minutes ago` for the live-region sentence (§11). */
export function agoWords(ts: string, now = Date.now()): string {
  const mins = Math.max(0, Math.round((now - new Date(ts).getTime()) / 60_000))
  if (mins < 60) return `${mins} ${mins === 1 ? 'minute' : 'minutes'} ago`
  const h = Math.round(mins / 60)
  if (h < 48) return `${h} ${h === 1 ? 'hour' : 'hours'} ago`
  const d = Math.round(h / 24)
  return `${d} days ago`
}

export function isoOf(ms: number | null): string | null {
  return ms == null ? null : new Date(ms).toISOString()
}

/** Newest of a list of ISO timestamps, or null. */
export function newestTs(list: (string | null | undefined)[]): string | null {
  let best: string | null = null
  for (const t of list) if (t && (!best || new Date(t).getTime() > new Date(best).getTime())) best = t
  return best
}

/** Re-render every `ms` (countdowns are content, not motion: they tick under reduced motion too). */
export function useNow(ms = 60_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [ms])
  return now
}

/**
 * Inline form open/close (DESIGN-terminal §11): first field focuses on open
 * (autoFocus at the call site), Esc closes and refocuses the opener.
 */
export function useInlineForm() {
  const [open, setOpen] = useState(false)
  const openerRef = useRef<HTMLButtonElement>(null)
  const close = useCallback(() => {
    setOpen(false)
    requestAnimationFrame(() => openerRef.current?.focus())
  }, [])
  const show = useCallback(() => setOpen(true), [])
  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        close()
      }
    },
    [close],
  )
  return { open, show, close, openerRef, onKeyDown }
}

/** Split a comma list (`BTC, ETH`) into trimmed non-empty entries. */
export function commaList(s: string): string[] {
  return s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
}

// Formatting for the Intel tool surfaces (DESIGN-terminal §4–§6). Every
// computed number prints its sign (DESIGN §2.1); the minus is U+2212.
// Timestamps are UTC.


/** Signed number: `+1.40`, `−0.38`, `0.00`. */
export function fmtSignedNum(n: number | null | undefined, decimals = 2): string {
  if (n == null || !Number.isFinite(n)) return '—'
  const v = Number(n.toFixed(decimals))
  const body = Math.abs(v).toFixed(decimals)
  return v > 0 ? `+${body}` : v < 0 ? `${MINUS}${body}` : body
}

/** Signed R multiple: `+1.4R`. */
export function fmtR(r: number | null | undefined, decimals = 1): string {
  return r == null || !Number.isFinite(r) ? '—' : `${fmtSignedNum(r, decimals)}R`
}

/** Signed percent from an already-scaled percent number: `−3.2%`. */
export function fmtPctNum(p: number | null | undefined, decimals = 1): string {
  return p == null || !Number.isFinite(p) ? '—' : `${fmtSignedNum(p, decimals)}%`
}

/** Signed USD: `+$12.30`, `−$4.00`. */
export function fmtUsdSigned2(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  const body = `$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  return n > 0 ? `+${body}` : n < 0 ? `${MINUS}${body}` : body
}

/** Hold duration: `45M`, `3H`, `2D 4H`. */
export function fmtHold(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—'
  const m = Math.floor(ms / 60_000)
  if (m < 60) return `${m}M`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}H`
  const d = Math.floor(h / 24)
  const rh = h % 24
  return rh ? `${d}D ${rh}H` : `${d}D`
}

/** `MM-DD HH:mm` in UTC. */
export function fmtMdHm(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toISOString().slice(5, 16).replace('T', ' ')
}

/** Compact price level: `$79.2K`, `$1.25M`, `$0.0123`. */
export function fmtLevel(n: number): string {
  const abs = Math.abs(n)
  const trim = (x: number, d: number) => String(Number(x.toFixed(d)))
  let body: string
  if (abs >= 1e9) body = `${trim(abs / 1e9, 2)}B`
  else if (abs >= 1e6) body = `${trim(abs / 1e6, 2)}M`
  else if (abs >= 1e3) body = `${trim(abs / 1e3, 2)}K`
  else if (abs >= 1) body = trim(abs, 2)
  else body = String(Number(abs.toPrecision(3)))
  return `${n < 0 ? MINUS : ''}$${body}`
}

/** Comparison operators typeset: `>=` → `≥`. */
export function fmtOp(op: string): string {
  return op === '>=' ? '≥' : op === '<=' ? '≤' : op === '!=' ? '≠' : op
}

/** Tailwind class for a signed value (green / red / quiet). The sign always prints too. */
export function signClass(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n === 0) return 'text-text-secondary'
  return n > 0 ? 'text-green' : 'text-red-text'
}
