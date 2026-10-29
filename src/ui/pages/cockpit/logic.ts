import { fmtDur, fmtSigned } from '../../lib/format'
import {
  bucketBounds, PRE_DECISION_STATUSES, TERMINAL_STATUSES, type FeedRow, type LiqBucket, type LiqCell, type OpportunityStatus, type PlatformHealth,
} from '../../../shared/platform'

// Cockpit pure helpers (DESIGN-terminal § Cockpit C9). No React, no DOM: the
// feed filter, health levels, keyboard map, edge word and the history canvas
// geometry, all tested in logic.test.ts. Clusters come from the server
// (LiqMap.nearestClusters).

// ─── Feed (C3) ───

export type StatusFilter = 'live' | 'ready' | 'decided' | 'all'
export type TierFilter = 'all' | 1 | 2 | 3

const STATUS_SETS: Record<Exclude<StatusFilter, 'all'>, readonly OpportunityStatus[]> = {
  live: PRE_DECISION_STATUSES,
  ready: ['ready'],
  decided: ['approved', 'open', ...TERMINAL_STATUSES],
}

/** Before the operator decides: snooze, research and the feed's LIVE filter apply. */
export const isLive = (s: OpportunityStatus) => PRE_DECISION_STATUSES.includes(s)

/** Client-side filter over the one feed fetch; server order (score desc) kept. Snoozed rows split out. */
export function filterFeed(rows: readonly FeedRow[], status: StatusFilter, tier: TierFilter, now: number): { ranked: FeedRow[]; snoozed: FeedRow[] } {
  const ranked: FeedRow[] = []
  const snoozed: FeedRow[] = []
  for (const r of rows) {
    if (status !== 'all' && !STATUS_SETS[status].includes(r.status)) continue
    if (tier !== 'all' && r.liquidityTier !== tier) continue
    ;(r.snoozedUntil && Date.parse(r.snoozedUntil) > now ? snoozed : ranked).push(r)
  }
  return { ranked, snoozed }
}

/** j/k: next/previous id; a selection outside the list resumes from the top. */
export function stepSelection(ids: readonly string[], current: string | null, delta: 1 | -1): string | null {
  if (ids.length === 0) return null
  const i = current == null ? -1 : ids.indexOf(current)
  if (i === -1) return ids[0]!
  return ids[Math.min(ids.length - 1, Math.max(0, i + delta))]!
}

export type EdgeWord = { text: string; tone: 'green' | 'red' | 'gray'; costsExceed: boolean; unvalidated: boolean; title?: string }

/** Edge cell (C3). Score and edge are never combined. */
export function edgeWord(row: Pick<FeedRow, 'netEdgeBps' | 'edgeBasis' | 'tradeType'>): EdgeWord {
  if (row.netEdgeBps == null) return { text: '—', tone: 'gray', costsExceed: false, unvalidated: false, title: `no cost model for ${row.tradeType}` }
  const n = row.netEdgeBps
  return {
    text: fmtSigned(n, 'bp'),
    tone: n < 0 ? 'gray' : n > 0 ? 'green' : 'gray',
    costsExceed: n < 0,
    unvalidated: row.edgeBasis === 'unvalidated',
  }
}

/** `+38bp`, `−5.4%`: sign (typographic minus) + magnitude + unit. */
export { fmtSigned }
/** A fraction as a signed percent (0.021 → `+2.10%`). */
export const fmtSignedPct = (frac: number, dp = 2) => fmtSigned(frac * 100, '%', dp)

// ─── Liquidation map (C4) ───

/** Fill gaps so the profile has one band per grid index (category bands then line up with log price). */
export function denseBuckets(buckets: readonly LiqBucket[], bucketBps: number): LiqBucket[] {
  if (buckets.length === 0) return []
  const by = new Map(buckets.map((b) => [b.idx, b]))
  const lo = Math.min(...by.keys())
  const hi = Math.max(...by.keys())
  const out: LiqBucket[] = []
  for (let i = hi; i >= lo; i--) out.push(by.get(i) ?? { idx: i, longUsd: 0, shortUsd: 0, ...bucketBounds(i, bucketBps) })
  return out // highest price first (top of the chart)
}

export type CoverageTreatment = 'full' | 'partial' | 'none' | 'unknown'
/** < 25% partial map (amber, `≥` callouts); < 5% no cluster naming; null (OI unknown) is not 0%: clusters show, muted. */
export const coverageTreatment = (ratio: number | null): CoverageTreatment =>
  ratio == null ? 'unknown' : ratio < 0.05 ? 'none' : ratio < 0.25 ? 'partial' : 'full'

/** 95th percentile (nearest-rank) of the positive values; 0 when none. */
export function p95(values: readonly number[]): number {
  const v = values.filter((x) => x > 0).sort((a, b) => a - b)
  if (v.length === 0) return 0
  return v[Math.min(v.length - 1, Math.ceil(0.95 * v.length) - 1)]!
}

/** Alpha step 0..5 of a cell's notional over the window's p95 (clipped). */
export function alphaStep(usd: number, ref: number): number {
  if (usd <= 0 || ref <= 0) return 0
  return Math.max(1, Math.min(5, Math.ceil((usd / ref) * 5)))
}

/** Price → y pixel on a log axis spanning [lo, hi] (hi at y = 0). */
export const priceY = (px: number, lo: number, hi: number, height: number) => (height * (Math.log(hi) - Math.log(px))) / (Math.log(hi) - Math.log(lo))

/** Grid cell idx → its row rectangle on the shared log price axis. */
export function cellRow(idx: number, bucketBps: number, lo: number, hi: number, height: number): { y: number; h: number } {
  const { priceLo, priceHi } = bucketBounds(idx, bucketBps)
  const y = priceY(priceHi, lo, hi, height)
  return { y, h: priceY(priceLo, lo, hi, height) - y }
}

/** Which side a history cell belongs to, from that snapshot's mark. */
export function cellSide(cell: LiqCell, bucketBps: number, mark: number): 'long' | 'short' {
  const { priceLo, priceHi } = bucketBounds(cell.idx, bucketBps)
  return (priceLo + priceHi) / 2 < mark ? 'long' : 'short'
}

// ─── Health (C6) ───

export type Level = 'ok' | 'warn' | 'critical' | 'unknown'
export type HealthItem = { key: 'WS' | 'SCAN' | 'CRAWL' | 'LOOPS' | 'LLM'; level: Level; value: string; title?: string }


export function healthItems(h: PlatformHealth, now: number): HealthItem[] {
  const ws = h.ws
  const wsAge = ws.lastMessageAgeSec
  const wsLevel: Level = ws.state !== 'open' || (wsAge != null && wsAge > 30) ? 'critical' : wsAge == null ? 'unknown' : wsAge > 10 ? 'warn' : 'ok'
  const scan = h.scanAgeSec
  const scanLevel: Level = scan == null ? 'unknown' : scan > 120 ? 'critical' : scan > 90 ? 'warn' : 'ok'
  const ppm = h.crawler.pollsPerMin
  const crawlLevel: Level = ppm === 0 ? 'critical' : ppm < 100 ? 'warn' : 'ok'
  const loopRatio = (l: PlatformHealth['loops'][number]) => (l.lastBeatAt == null ? Infinity : (now - Date.parse(l.lastBeatAt)) / 1000 / l.expectedIntervalSec)
  const worst = Math.max(0, ...h.loops.map(loopRatio))
  const crashed = h.loops.some((l) => !l.ok)
  const beating = h.loops.filter((l) => l.ok && loopRatio(l) <= 2).length
  const loopLevel: Level = h.loops.length === 0 ? 'unknown' : crashed || worst > 5 ? 'critical' : worst > 2 ? 'warn' : 'ok'
  const loopTitle = h.loops
    .map((l) => `${l.name}: ${l.lastBeatAt ? `${fmtDur((now - Date.parse(l.lastBeatAt)) / 1000)} ago` : 'never'}${l.error ? ` — ${l.error}` : ''}`)
    .join('\n')
  return [
    { key: 'WS', level: wsLevel, value: ws.state !== 'open' ? ws.state.toUpperCase() : wsAge == null ? '—' : fmtDur(wsAge) },
    { key: 'SCAN', level: scanLevel, value: scan == null ? '—' : fmtDur(scan) },
    { key: 'CRAWL', level: crawlLevel, value: `${Math.round(ppm)}/MIN · ${h.crawler.addresses.toLocaleString('en-US')} ADDR` },
    { key: 'LOOPS', level: loopLevel, value: `${beating}/${h.loops.length}`, title: loopTitle || undefined },
    // No cap in the contract (C9 fallback): spend shown, dot gray.
    { key: 'LLM', level: 'unknown', value: h.llmSpendUsdToday == null ? '—' : `$${h.llmSpendUsdToday.toFixed(2)}`, title: 'daily cap not reported by /health' },
  ]
}

const LEVEL_RANK: Record<Level, number> = { critical: 3, warn: 2, unknown: 1, ok: 0 }
/** Phone: the worst item (`● SCAN 3M OLD`). */
export const worstItem = (items: readonly HealthItem[]) => items.reduce((a, b) => (LEVEL_RANK[b.level] > LEVEL_RANK[a.level] ? b : a))

// ─── Keyboard (C3) ───

export type KeyAction =
  | { type: 'next' }
  | { type: 'prev' }
  | { type: 'open' }
  | { type: 'approve' }
  | { type: 'reject' }
  | { type: 'snoozeMenu' }
  | { type: 'snooze'; minutes: 15 | 60 | 240 }
  | { type: 'closeMenu' }
  | { type: 'research' }
  | { type: 'kill' }
  | { type: 'help' }

export interface KeyInput {
  key: string
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
  /** Tag name of the focused element. */
  target?: string
  editable?: boolean
  dialogOpen: boolean
  snoozeOpen: boolean
}

const SNOOZE_KEYS = { '1': 15, '2': 60, '3': 240 } as const

/** One page-level map; null = not ours (typing, a dialog, or a modifier). Dialogs own their Esc. */
export function keyAction(e: KeyInput): KeyAction | null {
  if (e.ctrlKey || e.metaKey || e.altKey || e.dialogOpen || e.editable) return null
  if (e.target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.toUpperCase())) return null
  if (e.snoozeOpen) {
    if (e.key === 'Escape') return { type: 'closeMenu' }
    const m = SNOOZE_KEYS[e.key as keyof typeof SNOOZE_KEYS]
    return m ? { type: 'snooze', minutes: m } : null
  }
  switch (e.key) {
    case 'j': return { type: 'next' }
    case 'k': return { type: 'prev' }
    case 'Enter': return { type: 'open' }
    case 'a': return { type: 'approve' }
    case 'r': return { type: 'reject' }
    case 's': return { type: 'snoozeMenu' }
    case 'd': return { type: 'research' }
    case 'x': return { type: 'kill' }
    case '?': return { type: 'help' }
    default: return null
  }
}

export const STATUS_WORD: Record<OpportunityStatus, string> = {
  new: 'NEW',
  investigating: 'INVESTIGATING',
  calculated: 'CALC',
  ready: 'READY',
  approved: 'APPROVED',
  open: 'OPEN',
  rejected: 'REJECTED',
  expired: 'EXPIRED',
  closed: 'CLOSED',
  failed: 'FAILED',
}
