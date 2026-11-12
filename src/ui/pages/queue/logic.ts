import type { AgentRecord } from '../../../shared/agentRecords'
import { QUEUE_SOURCES, type QueueItem, type QueueResponse, type QueueSource } from '../../../shared/queue'
import type { Term, Tone } from '../../components'
import { fmtDur } from '../../lib/format'
import { GUIDE } from '../moves/guide'
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

/**
 * `moves run 3h old · triage 40m old`: the stale moves-pipeline inputs (QueueResponse.freshness), aged to `now`; null
 * when both are fresh or not stored. The one honesty signal a schedule-driven deployment needs on the home screen.
 */
export function staleLine(q: Pick<QueueResponse, 'freshness'>, now: number): string | null {
  const parts = ([['moves run', q.freshness.movesRun], ['triage', q.freshness.triage]] as const)
    .filter(([, f]) => f?.stale)
    .map(([label, f]) => `${label} ${ageText(f!.at, now)} old`)
  return parts.length ? parts.join(' · ') : null
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

// ─── Reading guide ───

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/**
 * The list's takeaway, facts only: `2 new today (MOVES 2, SETUP 1). 1 flagged by more than one source; 1 has an
 * agent record. 1 handled today.` Counts are of listed items; null when nothing is listed.
 */
export function queueTakeaway(q: Pick<QueueResponse, 'items'>): string | null {
  if (q.items.length === 0) return null
  const { open, handled } = splitItems(q.items)
  const out: string[] = []
  if (open.length > 0) {
    const by = QUEUE_SOURCES.map((s) => [PART_LABEL[s], open.filter((i) => i.parts.some((p) => p.source === s)).length] as const).filter(([, n]) => n > 0)
    out.push(`${open.length} new today (${by.map(([label, n]) => `${label} ${n}`).join(', ')}).`)
    const multi = open.filter((i) => i.parts.length > 1).length
    const recorded = open.filter((i) => i.record != null).length
    out.push(`${multi} flagged by more than one source; ${count(recorded, 'has', 'have')} an agent record.`)
  } else out.push('Nothing new.')
  if (handled.length > 0) out.push(`${handled.length} handled today.`)
  return out.join(' ')
}

/** What puts a coin in the queue, for the empty list; says so when no moves scan has run yet. */
export function emptyWhy(q: Pick<QueueResponse, 'watched' | 'sources'>): string {
  const bar = `A coin is listed when the moves scan measures an unusual 24h move (residual z of ${GUIDE.queueZ} or more with a move of at least ${GUIDE.queueMinMovePct}%) or a fully met ENTER or FADE checklist, when the scanner has a ready setup, or when the radar lands a call.`
  return q.sources.moves.state === 'ok' && q.watched === 0 ? `${bar} No moves scan is stored yet, so MOVES has ranked nothing.` : bar
}

/** The words a queue reason is made of (written by code in src/server/moves/triage.ts and src/server/queue/merge.ts). */
export const REASON_TERMS: readonly Term[] = [
  ['residual +6.2%', 'The coin’s 24h move minus the part that tracks BTC, ETH and its sector. Unexplained, not a cause.'],
  ['z +3.1', `That residual divided by its usual size for this coin over 24h. The queue bar is ${GUIDE.queueZ} in either direction, with a total move of at least ${GUIDE.queueMinMovePct}%.`],
  ['no news in window · news in 3h · news unknown', 'Hours of the 24h window that had a news item naming the coin. Unknown: the news feed is not being ingested.'],
  ['FADE 3/3 · ENTER 3/3', 'A checklist with every condition met. FADE: one side crowded, attention saturated, liquidations nearby. ENTER: attention rising, little crowding, a residual z of 1.5 or more.'],
  ['crowd long 3/4', 'Crowding checks met on that side, out of those that could be evaluated.'],
  ['crowded_short long · ready · net 42 bps', 'A scanner setup: its kind, side, status, and its expected edge after fees, slippage and funding in basis points (1 bp = 0.01%).'],
  ['ride long · catalyst · kill 31.2', 'A radar call: stance (ride or fade), side, kind, and the price at which the call is closed.'],
]

export const QUEUE_TERMS: readonly Term[] = [
  ['listed of N', 'Coins on today’s list out of the daily cap. One cap covers all three sources; the day is the UTC day.'],
  ['weaker over cap', 'Coins that crossed a bar but ranked below the listed ones. Counted, not shown.'],
  ['MOVES', `Flagged by the moves scan: on the 24h window its residual z is ${GUIDE.queueZ} or more in size with a total move of at least ${GUIDE.queueMinMovePct}%, or an ENTER or FADE checklist has all ${GUIDE.queueMinChecks} conditions met.`],
  ['SETUP', 'The scanner has a setup for this coin that is ready, or one that was decided today.'],
  ['RADAR', 'The twice-daily radar routine landed a call on this market today or yesterday, and its close price has not been reached.'],
  ['Source counts', 'Coins each source flagged today, before the cap. A source without a count could not be read; its reason is printed below.'],
  ['agents 2/6 today', 'Agent investigations run today out of the daily cap. An investigation is one LLM run that writes a hypothesis for a move.'],
  ['long · short · mixed · —', 'The side the sources state. MOVES states none (the sign is in its residual). Mixed: two sources disagree.'],
  ['14m · 2h', 'Time since the first source flagged the coin today.'],
  ...REASON_TERMS,
  ['OPEN record', 'An agent hypothesis for this coin is open and not graded yet.'],
  ['graded · hit / miss', 'The hypothesis reached its horizon. Hit: the coin beat BTC in the stated direction. Miss: it did not.'],
  ['falsified', 'Price reached the level the hypothesis named as proving it wrong.'],
  ['no cause found', 'The agent investigated and found no public cause for the move.'],
  ['Order of rows', 'Strongest first: the highest score (1 means the source’s bar was just crossed), then more sources agreeing, then the earlier flag.'],
  ['DISMISS', 'Hides the coin for today. It keeps its slot in the cap, and it is listed again if a source flags it afterwards with new facts.'],
  ['dismissed / acted', 'Coins dismissed today, and coins whose setup was decided today.'],
]
