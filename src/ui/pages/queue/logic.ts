import type { AgentRecord } from '../../../shared/agentRecords'
import { QUEUE_SOURCES, type QueueItem, type QueueResponse, type QueueSource } from '../../../shared/queue'
import type { Tone } from '../../components'
import { fmtDur } from '../../lib/format'
import { DASH } from '../moves/logic'

// QUEUE home (docs/SPEC.md § Queue, PLAN2 §2.1/§2.2). Pure helpers for QueueView and Queue.tsx: the header line,
// the source chips (a source problem is one quiet line, never a card), row labels, the default selection and the
// record chip. Facts only; nothing here judges an item.

export const PART_LABEL: Record<QueueSource, string> = { moves: 'MOVES', opportunity: 'SETUP', radar: 'RADAR' }
export const partLabel = (s: QueueSource): string => PART_LABEL[s]

/** `QUEUE · 5 listed of 8 · 2 weaker over cap`. */
export function headerLine(q: Pick<QueueResponse, 'items' | 'cap' | 'overCap'>): string {
  const over = q.overCap > 0 ? ` · ${q.overCap} weaker over cap` : ''
  return `QUEUE · ${q.items.length} listed of ${q.cap}${over}`
}

export interface SourceChip {
  source: QueueSource
  label: string
  ok: boolean
  count: number
  /** Hover text: the reason when unavailable, else what the count means. */
  title: string
}
export function sourceChips(q: Pick<QueueResponse, 'sources'>): SourceChip[] {
  return QUEUE_SOURCES.map((s) => {
    const st = q.sources[s]
    const ok = st.state === 'ok'
    return { source: s, label: PART_LABEL[s], ok, count: st.count, title: ok ? `${st.count} ${st.count === 1 ? 'coin' : 'coins'} today, before the cap` : (st.reason ?? 'unavailable') }
  })
}

/** One quiet line naming the sources that could not be read and why; null when all are fine. */
export function sourceProblemLine(q: Pick<QueueResponse, 'sources'>): string | null {
  const off = sourceChips(q).filter((c) => !c.ok)
  return off.length ? off.map((c) => `${c.label} off: ${c.title}`).join(' · ') : null
}

/** `agents 2/6 today`, plus why INVESTIGATE is off when it is. */
export function agentLine(q: Pick<QueueResponse, 'agentRuns' | 'agentCap' | 'agentBlockedReason'>): string {
  return `agents ${q.agentRuns}/${q.agentCap} today${q.agentBlockedReason ? ` · investigate off: ${q.agentBlockedReason}` : ''}`
}

/** The calm empty line: nothing crossed the bar, and how wide the watch is when known. */
export function emptyLine(watched: number | null): string {
  return watched && watched > 0 ? `nothing crossed the bar today · ${watched} coins watched` : 'nothing crossed the bar today'
}

/** `MOVES·SETUP`. */
export const partsLabel = (i: Pick<QueueItem, 'parts'>): string => i.parts.map((p) => PART_LABEL[p.source]).join('·')

/** The parts' side: one side, `mixed` when they disagree, a dash when none states one (a moves part). */
export function directionOf(i: Pick<QueueItem, 'parts'>): string {
  const sides = [...new Set(i.parts.flatMap((p) => p.direction ?? []))]
  return sides.length === 0 ? DASH : sides.length === 1 ? sides[0]! : 'mixed'
}

/** Time in the queue from the first part: `14m`, `2h`. */
export const ageText = (firstAt: string, now: number): string => {
  const ms = now - Date.parse(firstAt)
  return Number.isFinite(ms) ? fmtDur(ms / 1000).toLowerCase() : DASH
}

/** New items lead; acted and dismissed ones sit in the collapsed group (they keep their slot for the day). */
export function splitItems(items: readonly QueueItem[]): { open: QueueItem[]; handled: QueueItem[] } {
  return { open: items.filter((i) => i.state === 'new'), handled: items.filter((i) => i.state !== 'new') }
}

/** `?coin=` when it names a listed item (any case) or any coin; else the first new item, else the first item. */
export function defaultSelection(items: readonly QueueItem[], param: string | null): string | null {
  const p = param?.trim()
  if (p) return items.find((i) => i.coin.toLowerCase() === p.toLowerCase())?.coin ?? p
  return (items.find((i) => i.state === 'new') ?? items[0])?.coin ?? null
}

/** The agent record's state as a short chip; null without a record. */
export function recordChip(r: Pick<AgentRecord, 'status' | 'grade'> | null): { label: string; tone: Tone } | null {
  if (!r) return null
  switch (r.status) {
    case 'open': return { label: 'OPEN record', tone: 'info' }
    case 'graded': return { label: r.grade?.hit === true ? 'graded · hit' : r.grade?.hit === false ? 'graded · miss' : 'graded', tone: 'gray' }
    case 'falsified': return { label: 'falsified', tone: 'gray' }
    case 'no_cause': return { label: 'no cause found', tone: 'gray' }
    case 'failed': return { label: 'investigation failed', tone: 'gray' }
    case 'capped': return { label: 'agent cap reached', tone: 'gray' }
  }
}
