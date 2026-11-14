import type { AgentFalsifier, AgentRecord, AgentStatsResponse } from '../../../shared/agentRecords'
import { MOVE_WINDOWS, simplePct, type Attribution, type CrowdingCheck, type LayerState, type MoveRow, type MovesResponse, type MoveSeriesPoint, type MoveWindow, type Positioning, type SetupChecklist } from '../../../shared/moves'
import type { DefinitionsResponse } from '../../../shared/research'
import { fmtPx, fmtSigned } from '../../lib/format'
import { studyHref } from '../../lib/study'
import { keyAction, type KeyInput } from '../cockpit/logic'

// MOVES pure helpers (docs/design/README.md § MOVES, PLAN §2). No React, no DOM: window and sort parsing, row
// order, bar geometry, the words every panel prints (budget line, stale banner, reasons) and the outbound
// links, all tested in logic.test.ts. Every number's null prints `—` with its reason, never 0.

export const DASH = '—'
const DEFAULT_WINDOW: MoveWindow = '24h'
export const NOT_A_FORECAST = 'CONDITION CHECK · NOT A FORECAST'
/** Residual buckets are hour-bucket splits with precedence, not causes (SPEC § Moves). */
export const BUCKET_LABEL = { flow: 'in OI-drop hours', news: 'in news hours', other: 'other hours' } as const
const STALE_AFTER_HOURS = 2
const MIN_CLUSTERS = 5

// ─── URL state ───

/** `?window=` → a window; anything else is the default. */
export function parseWindow(raw: string | null | undefined): MoveWindow {
  return (MOVE_WINDOWS as readonly string[]).includes(raw ?? '') ? (raw as MoveWindow) : DEFAULT_WINDOW
}

export type SortKey = 'z' | 'total' | 'crowd'
export const SORT_KEYS: readonly SortKey[] = ['z', 'total', 'crowd']
export const SORT_LABEL: Record<SortKey, string> = { z: '|Z|', total: 'TOTAL', crowd: 'CROWD' }

export function parseSort(raw: string | null | undefined): SortKey {
  return (SORT_KEYS as readonly string[]).includes(raw ?? '') ? (raw as SortKey) : 'z'
}

/** `?coin=` normalised to an upper-case ticker, or null. */
export const parseCoin = (raw: string | null | undefined): string | null => {
  const c = raw?.trim().toUpperCase()
  return c ? c : null
}

// ─── Table: order, filter, bars ───

const absOr = (n: number | null | undefined) => (n == null ? null : Math.abs(n))
/** The larger side's crowding checks met. */
export const crowdScore = (p: Pick<Positioning, 'longMet' | 'shortMet'>) => Math.max(p.longMet, p.shortMet)

/** Descending by the key, rows without a value last; ties by coin so the order is stable. Never mutates. */
export function sortRows(rows: readonly MoveRow[], key: SortKey): MoveRow[] {
  const value = (r: MoveRow): number | null =>
    key === 'z' ? absOr(r.attribution?.residualZ) : key === 'total' ? absOr(r.attribution?.totalPct) : crowdScore(r.positioning)
  return [...rows].sort((a, b) => {
    const av = value(a)
    const bv = value(b)
    if (av == null && bv == null) return a.coin.localeCompare(b.coin)
    if (av == null) return 1
    if (bv == null) return -1
    return bv - av || a.coin.localeCompare(b.coin)
  })
}

/** `?sector=` filter; null = all. */
export const filterSector = (rows: readonly MoveRow[], sector: string | null): MoveRow[] => (sector ? rows.filter((r) => r.sector?.id === sector) : [...rows])

/** `sector:ai` → `ai`; BTC, ETH and ETHX are not sectors. */
export const sectorOfFactor = (id: string): string | null => (id.startsWith('sector:') ? id.slice('sector:'.length) || null : null)

/** The shared bar scale: the largest |residual| among the shown rows (null when none has one). */
export function barScale(rows: readonly MoveRow[]): number {
  let max = 0
  for (const r of rows) max = Math.max(max, Math.abs(r.attribution?.residualPct ?? 0))
  return max
}

/** Width of a signed bar as 0..100 (% of one half), 1 dp; null or an empty scale is 0. */
export function barWidth(residualPct: number | null | undefined, scale: number): number {
  if (residualPct == null || !(scale > 0)) return 0
  return Math.round(Math.min(1, Math.abs(residualPct) / scale) * 1000) / 10
}

export const zWarn = (z: number | null | undefined) => z != null && Math.abs(z) >= 2
export const fmtZ = (z: number | null | undefined) => (z == null ? DASH : fmtSigned(z, '', 1))
export const fmtPct = (n: number | null | undefined, dp = 1) => fmtSigned(n, '%', dp)
/** A move the contract carries in log-%, printed as the ordinary percent change (shared/moves simplePct). */
export const fmtMove = (logPct: number | null | undefined, dp = 1) => fmtPct(logPct == null ? logPct : simplePct(logPct), dp)

/** Beta = btc + eth contribution; null without an attribution. */
export const betaPct = (a: Attribution | null): number | null => (a ? a.btcPct + a.ethPct : null)

/** `3/4 · 0/4` (long checks met · short checks met, of the evaluable ones); a dash when none is evaluable. */
export const crowdText = (p: Pick<Positioning, 'longMet' | 'shortMet' | 'of'>): string => (p.of === 0 ? DASH : `${p.longMet}/${p.of} · ${p.shortMet}/${p.of}`)

/** Nearest cluster distance in 24h sigmas, with its side: `0.8σ L` / `1.4σ S`; null when neither is known. */
export function liqSigmaText(liq: Pick<MoveRow['liq'], 'longSigmas' | 'shortSigmas'>): string {
  const { longSigmas: l, shortSigmas: s } = liq
  if (l == null && s == null) return DASH
  if (s == null || (l != null && l <= s)) return `${l!.toFixed(1)}σ L`
  return `${s.toFixed(1)}σ S`
}

/** The checklist closest to complete (met/of, then more checks), skipping any with no evaluable check. */
export function bestChecklist(setups: readonly SetupChecklist[]): SetupChecklist | null {
  let best: SetupChecklist | null = null
  for (const s of setups) {
    if (s.of === 0) continue
    if (!best || s.met / s.of > best.met / best.of || (s.met / s.of === best.met / best.of && s.of > best.of)) best = s
  }
  return best
}
export const checklistText = (s: Pick<SetupChecklist, 'kind' | 'met' | 'of'>) => `${s.kind.toUpperCase()} ${s.met}/${s.of}`

/** A null attribution cell: a dash whose `title` is the server's reason. */
export const attributionCell = (r: Pick<MoveRow, 'attribution' | 'attributionReason'>): { text: string; title: string } | null =>
  r.attribution ? null : { text: DASH, title: r.attributionReason ?? 'no attribution for this window' }

/** TAGS cell: hours in the window with an OI drop / news. Null = the layer could not say. */
export function tagText(hours: number | null, label: string): string | null {
  return hours == null ? null : hours > 0 ? `${label} ${hours}H` : null
}

// ─── Header ───

/** `14:00 UTC` from an ISO time. */
const hhmm = (iso: string): string => new Date(iso).toISOString().slice(11, 16)

export const progressLine = (p: { loaded: number; total: number }): string => `FIRST RUN — ${p.loaded} OF ${p.total} COINS LOADED`

export const droppedTitle = (dropped: readonly { coin: string; reason: string }[]): string => dropped.map((d) => `${d.coin}: ${d.reason}`).join('\n')

/** The header sentence: pending progress, the unavailable reason verbatim, or asOf · coins · dropped. */
export function headerLine(m: Pick<MovesResponse, 'state' | 'reason' | 'asOf' | 'progress' | 'universe'>): string {
  if (m.state === 'pending') return m.progress ? progressLine(m.progress) : 'FIRST RUN — LOADING'
  if (m.state === 'unavailable') return m.reason ?? 'unavailable'
  const dropped = m.universe.dropped.length
  return [m.asOf ? `asOf ${hhmm(m.asOf)} UTC (last closed hour)` : 'asOf —', `${m.universe.coins} coins`, ...(dropped > 0 ? [`${dropped} dropped*`] : [])].join(' · ')
}

/** `attribution 3h old — last closed hour 11:00` once asOf is more than 2h old; null otherwise. */
export function staleLine(asOf: string | null, now: number): string | null {
  if (!asOf) return null
  const ageH = (now - Date.parse(asOf)) / 3_600_000
  if (!Number.isFinite(ageH) || ageH <= STALE_AFTER_HOURS) return null
  return `attribution ${Math.floor(ageH)}h old — last closed hour ${hhmm(asOf)}`
}

const LAYER_LABEL = { beta: 'BETA', flow: 'FLOW', attention: 'NEWS', liq: 'LIQ', agents: 'AGENTS' } as const
export type LayerKey = keyof typeof LAYER_LABEL
const DOT = { ok: 'ok', partial: 'degraded', unavailable: 'down' } as const

export interface LayerChip { key: LayerKey; label: string; dot: 'ok' | 'degraded' | 'down'; reason: string | null }
export function layerChips(layers: Record<LayerKey, LayerState>): LayerChip[] {
  return (Object.keys(LAYER_LABEL) as LayerKey[]).map((key) => ({ key, label: LAYER_LABEL[key], dot: DOT[layers[key].state], reason: layers[key].reason }))
}

// ─── Triage ───

/** INVESTIGATE costs one LLM run; it is off with the server's reason, or while a run for the coin is in flight. */
export function investigateGate(blockedReason: string | null, busy: boolean): { disabled: boolean; title: string } {
  if (blockedReason) return { disabled: true, title: blockedReason }
  if (busy) return { disabled: true, title: 'an investigation is running' }
  return { disabled: false, title: 'costs one LLM run (counts against the daily agent cap)' }
}

/** The 409 / 429 / 503 of POST /moves/:coin/investigate as words; anything else keeps the server's message. */
export function investigateFailure(status: number | undefined, message: string): string {
  if (status === 409) return 'an investigation for this coin is already running'
  if (status === 429) return 'daily agent cap reached'
  if (status === 503) return 'no LLM provider configured'
  return message || 'investigation failed'
}

// ─── Detail ───

export const falsifierLine = (f: AgentFalsifier, mark: number | null): string => {
  const dist = mark != null && mark > 0 ? ` (${fmtPct((f.level / mark - 1) * 100)} from mark)` : ''
  return `${f.side} ${fmtPx(f.level)}${dist} — ${f.text}`
}

export function gradeLine(r: Pick<AgentRecord, 'status' | 'grade' | 'horizonHours'>): string {
  if (!r.grade) {
    if (r.status === 'open') return `open — grades at ${r.horizonHours}h`
    return r.status === 'no_cause' ? 'not graded — no cause found' : `not graded — ${r.status}`
  }
  const g = r.grade
  return `${r.status === 'falsified' ? 'FALSIFIED' : 'GRADED'} at ${Math.round(g.atHours)}h · vs BTC ${fmtPct(g.relPct)} · ${g.hit ? 'hit' : 'miss'}`
}

/** `agent records: n 23 graded · hit 52% · mean vs BTC +0.4% [−0.6, +1.4] · 24h`; under 5 clusters `n<5 — not enough graded`. */
export function trackLine(stats: AgentStatsResponse | null, horizonHours: number): string {
  if (!stats) return 'agent records: —'
  const row = stats.byHorizon.find((r) => r.key === `${horizonHours}h`)
  if (!row || row.n === 0) return `agent records: none graded at ${horizonHours}h yet`
  if (row.clusters < MIN_CLUSTERS || row.meanRelPct == null || row.ci95 == null) return `agent records: n ${row.n} graded · n<5 — not enough graded · ${horizonHours}h`
  const hit = row.hitRate == null ? DASH : `${Math.round(row.hitRate * 100)}%`
  return `agent records: n ${row.n} graded · hit ${hit} · mean vs BTC ${fmtPct(row.meanRelPct)} [${fmtSigned(row.ci95[0], '', 1)}, ${fmtSigned(row.ci95[1], '', 1)}] · ${horizonHours}h`
}

export interface Segment { key: string; label: string; pct: number; width: number; kind: 'beta' | 'flow' | 'news' | 'other' }
/** The stacked bar: BTC, ETH, SECTOR and the residual split into OI-drop hours, news hours and the rest. Widths share Σ|part|. */
export function attributionSegments(a: Attribution): Segment[] {
  const parts: Omit<Segment, 'width'>[] = [
    { key: 'btc', label: 'BTC', pct: a.btcPct, kind: 'beta' },
    { key: 'eth', label: 'ETH ex-BTC', pct: a.ethPct, kind: 'beta' },
    ...(a.sectorPct != null ? [{ key: 'sector', label: 'SECTOR', pct: a.sectorPct, kind: 'beta' as const }] : []),
    ...(a.residualFlowPct != null ? [{ key: 'flow', label: `RESIDUAL ${BUCKET_LABEL.flow}`, pct: a.residualFlowPct, kind: 'flow' as const }] : []),
    ...(a.residualNewsPct != null ? [{ key: 'news', label: `RESIDUAL ${BUCKET_LABEL.news}`, pct: a.residualNewsPct, kind: 'news' as const }] : []),
    { key: 'other', label: `RESIDUAL ${BUCKET_LABEL.other}`, pct: a.residualOtherPct, kind: 'other' },
  ]
  const total = parts.reduce((s, p) => s + Math.abs(p.pct), 0)
  return parts.map((p) => ({ ...p, width: total > 0 ? Math.round((Math.abs(p.pct) / total) * 1000) / 10 : 0 }))
}

export interface ChartData { points: { t: number; actual: number; fitted: number }[]; marks: { t: number; y: number; kind: 'flow' | 'news' }[] }
/** Cumulative actual vs beta-fitted in ordinary percent, with a mark on each OI-drop and news hour (both when an hour is both). */
export function chartData(series: readonly MoveSeriesPoint[]): ChartData {
  const points = series.map((p) => ({ t: p.t, actual: simplePct(p.cumTotalPct), fitted: simplePct(p.cumFittedPct) }))
  const marks: ChartData['marks'] = []
  for (const p of series) {
    if (p.flowHour) marks.push({ t: p.t, y: simplePct(p.cumTotalPct), kind: 'flow' })
    if (p.newsHour) marks.push({ t: p.t, y: simplePct(p.cumTotalPct), kind: 'news' })
  }
  return { points, marks }
}

const CHECK_UNIT: Record<CrowdingCheck['key'], string> = { funding_z: '', funding_apr: '%', oi_build: '%', premium: 'bp' }
export const CHECK_LABEL: Record<CrowdingCheck['key'], string> = { funding_z: 'funding z', funding_apr: 'funding APR', oi_build: 'OI build 72h', premium: 'premium' }
export const checkValue = (key: CrowdingCheck['key'], v: number | null): string => (v == null ? DASH : fmtSigned(v, CHECK_UNIT[key], key === 'funding_z' ? 1 : key === 'premium' ? 1 : 0))
export const metMark = (met: boolean | null): string => (met == null ? DASH : met ? '✓' : '✗')

/** `z 2.3 · n 336`; a null z says how much history it still needs. */
export const fundingZText = (p: Pick<Positioning, 'fundingZ' | 'fundingN'>): string => (p.fundingZ == null ? `z — · n ${p.fundingN} of 168` : `z ${p.fundingZ.toFixed(1)} · n ${p.fundingN}`)

/** `needs a database`-style copy for a layer that is not ok; the server's reason first. */
export const layerNote = (l: LayerState, fallback: string): string | null => (l.state === 'unavailable' ? (l.reason ?? fallback) : l.state === 'partial' ? (l.reason ?? 'partial') : null)

export type CoverageCopy = { kind: 'full' | 'partial' | 'none' | 'unknown'; text: string | null }
export function coverageCopy(ratio: number | null): CoverageCopy {
  if (ratio == null) return { kind: 'unknown', text: 'coverage unknown' }
  const pct = `${Math.round(ratio * 100)}% of OI mapped`
  if (ratio < 0.05) return { kind: 'none', text: `too little coverage to name clusters · ${pct}` }
  if (ratio < 0.25) return { kind: 'partial', text: `PARTIAL MAP · ${pct}` }
  return { kind: 'full', text: pct }
}

/** `needs 120 of 168…` copy for a null attribution is the server's own string; this is the BTC special case. */
export const isFactorCoin = (coin: string) => coin === 'BTC'

// ─── Links ───

export interface LinkSpec { key: string; label: string; to: string; title: string }
const enc = encodeURIComponent

/** The /lab/study link of a checklist's shipped definition; null without a definition or its rule. */
export function studyLinkFor(defs: DefinitionsResponse | null, definitionId: string | null, coin: string): string | null {
  if (!definitionId || !defs) return null
  const d = defs.definitions.find((x) => x.id === definitionId)
  return d ? studyHref(d.rule, coin) : null
}

/** Outbound links of the selected coin. Nothing here approves or places an order. */
export function outboundLinks(row: Pick<MoveRow, 'coin' | 'opportunityId' | 'setups'>, defs: DefinitionsResponse | null): LinkSpec[] {
  const c = enc(row.coin)
  const links: LinkSpec[] = [
    { key: 'coin', label: 'COIN', to: `/coin/${c}`, title: `decide on ${row.coin}: why it moved, priced in, attention, checklist, agent record` },
    { key: 'evidence', label: 'EVIDENCE', to: `/?coin=${c}`, title: `research board signals for ${row.coin}` },
    { key: 'chart', label: 'CHART', to: `/coin/${c}?chart=price`, title: 'price chart, funding and OI on the coin page' },
  ]
  if (row.opportunityId) links.push({ key: 'opportunity', label: 'OPPORTUNITY', to: `/coin/${c}`, title: 'the ready opportunity on the coin page (APPROVE and REJECT sit there)' })
  for (const s of row.setups) {
    const to = studyLinkFor(defs, s.definitionId, row.coin)
    if (to) {
      links.push({ key: 'study', label: 'STUDY', to, title: `event study of ${s.definitionId} (daily version)` })
      break
    }
  }
  links.push({ key: 'order', label: 'ORDER', to: '/order', title: 'order ticket (does not read parameters)' })
  return links
}

// ─── Keyboard ───

/** j/k/Enter only; the Cockpit's map with every other key left to the browser. */
export function moveKey(e: Omit<KeyInput, 'snoozeOpen'>): 'next' | 'prev' | 'open' | null {
  const a = keyAction({ ...e, snoozeOpen: false })
  return a && (a.type === 'next' || a.type === 'prev' || a.type === 'open') ? a.type : null
}
