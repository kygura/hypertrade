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

/** Locally prepended results first, then the poll; dedup by id (the server copy wins), newest first. */
export function mergeResearch(local: ResearchResult[], items: ResearchResult[]): ResearchResult[] {
  const seen = new Set(items.map((r) => r.id))
  return [...local.filter((r) => !seen.has(r.id)), ...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
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

/**
 * Why the box and the chip action are disabled, or null. Question length is
 * the box's own check. `conflict` = a 409 not yet cleared by a poll showing no
 * running row; `limitDay` = the UTC day a 429 was seen.
 */
export function askDisabledReason(p: {
  busy: boolean
  items: ResearchResult[]
  usedToday?: number
  limit?: number
  conflict: boolean
  limitDay: string | null
  now?: number
}): string | null {
  if (p.busy || p.conflict || p.items.some((r) => r.status === 'running')) return IN_FLIGHT
  const today = new Date(p.now ?? Date.now()).toISOString().slice(0, 10)
  if (p.usedToday != null && p.limit != null && p.usedToday >= p.limit) return `daily research limit reached (${p.usedToday} / ${p.limit}) — resets 00:00 UTC`
  if (p.limitDay === today) return 'daily research limit reached — resets 00:00 UTC'
  return null
}
