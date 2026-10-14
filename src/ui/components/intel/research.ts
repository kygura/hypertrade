import type { FlowFlag, ResearchEvidence, ResearchResult, ResearchStatus } from '../../../shared/intel'
import type { Tone } from '../Badge'
import type { LineClaim } from './ClaimLine'
import { flagWord } from './flow'

// Pure helpers for the RESEARCH panel, the chip action and confluence
// (DESIGN-terminal §16; the flow.ts precedent). Research is model output with
// code-checked provenance: evidence goes through §2 as OBS/HYP, and nothing
// here ever phrases a result as an instruction.

function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return 'source'
  }
}

/** observed → OBS with hostname source + ts (null ts → no ClaimAge); hypothesis → HYP, a kept url rides inside the text block. */
export function toClaim(e: ResearchEvidence): LineClaim {
  if (e.type === 'observed' && e.url) return { tag: 'observed', text: e.claim, source: { label: hostLabel(e.url), url: e.url }, ts: e.ts }
  return e.url ? { tag: 'hypothesis', text: e.claim, source: { label: hostLabel(e.url), url: e.url } } : { tag: 'hypothesis', text: e.claim }
}

const STATUS_WORD: Record<ResearchStatus, string> = { running: 'RUNNING', found: 'FOUND', no_cause: 'NO CAUSE', capped: 'CAPPED', failed: 'FAILED' }
const STATUS_TONE: Record<ResearchStatus, Tone> = { running: 'gray', found: 'gray', no_cause: 'gray', capped: 'amber', failed: 'red' }

export const statusWord = (s: ResearchStatus): string => STATUS_WORD[s]
/** `no_cause` is a valid answer: gray like `found`, never amber. */
export const statusTone = (s: ResearchStatus): Tone => STATUS_TONE[s]

/** `What explains crowded long on HYPE over 24h?` */
export function chipQuestion(f: Pick<FlowFlag, 'kind' | 'name' | 'numbers' | 'asset' | 'window'>): string {
  return `What explains ${flagWord(f).toLowerCase()} on ${f.asset} over ${f.window}?`
}

/** `×1.25`, two decimals kept; null when ≤ 1 (nothing renders, never `×1.00`). */
export function confluenceText(factor: number | null | undefined): string | null {
  return factor != null && Number.isFinite(factor) && factor > 1 ? `×${factor.toFixed(2)}` : null
}

/** k = 1 + round((f − 1) / 0.25); the 1.50 cap reads `3 or more` (SPEC S0.6). */
export function confluenceTitle(factor: number, asset: string): string {
  const k = factor >= 1.5 ? '3 or more' : String(1 + Math.round((factor - 1) / 0.25))
  return `confluence ${confluenceText(factor) ?? `×${factor.toFixed(2)}`} — ${k} independent signal sources on ${asset} in the window (snapshot moves, flow detectors, flips, news); this item's own source is not counted`
}

/** Server value, two decimals, never recomputed. */
export const fmtCost = (usd: number): string => `$${usd.toFixed(2)}`

export const RESEARCH_LIST_LIMIT = 20

const settled = (r: ResearchResult) => (r.status === 'running' ? 0 : 1)

/**
 * Locally prepended results + the poll, deduplicated by id: a settled copy
 * beats a running one whichever side it comes from (a poll fetched before the
 * POST resolved must not resurrect RUNNING); between two settled copies the
 * server wins. Newest first, capped at 20 after sorting; `keepId` (the
 * highlighted card) survives the cap.
 */
export function mergeResearch(local: ResearchResult[], items: ResearchResult[], keepId: string | null = null): ResearchResult[] {
  const byId = new Map<string, ResearchResult>()
  for (const r of local) if (!byId.has(r.id)) byId.set(r.id, r)
  for (const r of items) {
    const cur = byId.get(r.id)
    if (!cur || settled(r) >= settled(cur)) byId.set(r.id, r)
  }
  const sorted = [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const head = sorted.slice(0, RESEARCH_LIST_LIMIT)
  const kept = keepId != null && !head.some((r) => r.id === keepId) ? sorted.find((r) => r.id === keepId) : undefined
  return kept ? [...head, kept] : head
}

/** The chip path's POST body: the chip question, the flag's coin and its id (§16.3). */
export function chipAskInput(f: Pick<FlowFlag, 'id' | 'kind' | 'name' | 'numbers' | 'asset' | 'window'>): { question: string; asset: string; flagId: string } {
  return { question: chipQuestion(f), asset: f.asset, flagId: f.id }
}

/** The ask box's named failure states (§16.6): 409 and 429 are not generic errors. */
export type AskState = 'idle' | 'offline' | 'busy' | 'limit' | 'error'

export function askState(a: { error: string | null; status: number | null; offline: boolean }): AskState {
  if (a.offline) return 'offline'
  if (!a.error) return 'idle'
  if (a.status === 409) return 'busy'
  if (a.status === 429) return 'limit'
  return 'error'
}

export const IN_FLIGHT = 'a research run is in flight — one at a time'

// ── ask gates (§16.6) ──
//
// conflictAt: a 409 seen at that ms, cleared by a poll fetched after it that
// shows no running row. limitDay: the UTC day a 429 was seen, cleared by a
// poll on a later UTC day. polledRunning: the last poll had a running row.

export interface ResearchGate {
  conflictAt: number | null
  limitDay: string | null
  polledRunning: boolean
}

export type ResearchGateEvent =
  | { type: 'askFailed'; status: number | null; at: number }
  | { type: 'polled'; running: boolean; fetchedAt: number }

export const RESEARCH_GATE_INIT: ResearchGate = { conflictAt: null, limitDay: null, polledRunning: false }

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10)

export function researchGate(s: ResearchGate, e: ResearchGateEvent): ResearchGate {
  if (e.type === 'askFailed') {
    if (e.status === 409) return { ...s, conflictAt: e.at }
    if (e.status === 429) return { ...s, limitDay: utcDay(e.at) }
    return s
  }
  return {
    polledRunning: e.running,
    conflictAt: s.conflictAt != null && !e.running && e.fetchedAt > s.conflictAt ? null : s.conflictAt,
    limitDay: s.limitDay != null && utcDay(e.fetchedAt) !== s.limitDay ? null : s.limitDay,
  }
}

/** A 409 or 429 gate just lifted: the stale ask error should go too. */
export function gateCleared(prev: ResearchGate, next: ResearchGate): boolean {
  return (prev.conflictAt != null && next.conflictAt == null) || (prev.limitDay != null && next.limitDay == null)
}

/** 15 s while a row is running or a 409 is unresolved, else 60 s. */
export function researchIntervalMs(s: ResearchGate): number {
  return s.polledRunning || s.conflictAt != null ? 15_000 : 60_000
}

/** Why the box and the chip action are disabled, or null. Question length is the box's own check. */
export function askDisabledReason(p: { busy: boolean; items: ResearchResult[]; usedToday?: number; limit?: number; gate: ResearchGate }): string | null {
  if (p.busy || p.gate.conflictAt != null || p.items.some((r) => r.status === 'running')) return IN_FLIGHT
  if (p.usedToday != null && p.limit != null && p.usedToday >= p.limit) return `daily research limit reached (${p.usedToday} / ${p.limit}) — resets 00:00 UTC`
  if (p.gate.limitDay != null) return 'daily research limit reached — resets 00:00 UTC'
  return null
}
