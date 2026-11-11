import type { MoveDetail } from '../../../shared/moves'
import type { QueueItem, QueuePart, QueueSource } from '../../../shared/queue'
import { fmtDur } from '../../lib/format'
import { boardHref } from '../../lib/research'

// COIN page pure helpers (PLAN2 §2.3–§2.6): URL parsing, the action list, the IN QUEUE lines and the reason line
// a coin without move attribution prints. No React, no DOM; tested in logic.test.ts. Nothing here approves or
// places an order: every action is a link, the ASK drawer, or INVESTIGATE (one agent run).

const enc = encodeURIComponent

export type ChartView = 'move' | 'price'
/** `?chart=` → `price` only when asked; the MOVE chart (attribution) is the default. */
export const parseChart = (raw: string | null | undefined): ChartView => (raw === 'price' ? 'price' : 'move')

/** `?liq=1` opens the LIQ MAP section. */
export const parseLiq = (raw: string | null | undefined): boolean => raw === '1'

export const simulatePrompt = (coin: string): string => `What if I had put 10% of my stack into ${coin} perps at 1x 30 days ago?`
/** The analyst in SIMULATE mode with the question prefilled (not sent: the user presses SIMULATE). */
export const simulateHref = (coin: string): string => `/analyst?mode=sim&q=${enc(simulatePrompt(coin))}`

export const coinHref = (coin: string) => `/coin/${enc(coin)}`

/** A dex-prefixed (HIP-3) market: the moves layer covers main-dex perps only, so it is never asked. */
export const isHip3 = (coin: string) => coin.includes(':')
export const hip3Reason = (coin: string) => `${coin} is a HIP-3 market: move attribution, positioning and the checklists cover main-dex perps only`

export interface CoinAction {
  key: string
  label: string
  title: string
  /** `link`: navigation only. `ask`: opens the ASK drawer. `investigate`: one agent run (POST /moves/:coin/investigate). */
  kind: 'link' | 'ask' | 'investigate'
  to?: string
}

/** The ready opportunity's id: an un-decided opportunity part of the queue item, else the detail's open one. */
export function opportunityId(item: QueueItem | null | undefined, detail: Pick<MoveDetail, 'opportunityId'> | null): string | null {
  const part = item?.parts.find((p) => p.source === 'opportunity' && p.actedAt == null)
  return part?.ref ?? detail?.opportunityId ?? null
}

/**
 * The action row (§2.6). INVESTIGATE only while no agent record is known for the coin (a record exists → the
 * AGENT RECORD block shows it). APPROVE stays on FEED: the coin page only links there, when a ready opportunity exists.
 */
export function coinActions(coin: string, item: QueueItem | null | undefined, detail: Pick<MoveDetail, 'opportunityId' | 'record'> | null): CoinAction[] {
  const actions: CoinAction[] = []
  if (!(detail?.record ?? item?.record)) actions.push({ key: 'investigate', label: 'INVESTIGATE', kind: 'investigate', title: 'costs one LLM run (counts against the daily agent cap)' })
  actions.push(
    { key: 'ask', label: 'ASK', kind: 'ask', title: `ask the analyst about ${coin}` },
    { key: 'simulate', label: 'SIMULATE', kind: 'link', to: simulateHref(coin), title: 'what-if in the analyst (prefilled, not sent)' },
    { key: 'order', label: 'ORDER', kind: 'link', to: '/order', title: 'order ticket (does not read parameters)' },
    { key: 'evidence', label: 'EVIDENCE', kind: 'link', to: boardHref(coin), title: `research board signals for ${coin}` },
  )
  const opp = opportunityId(item, detail)
  if (opp) actions.push({ key: 'opportunity', label: 'OPPORTUNITY · APPROVE ON FEED', kind: 'link', to: `/feed?id=${enc(opp)}`, title: 'the ready opportunity: APPROVE lives on the feed' })
  actions.push({ key: 'moves', label: 'MOVES', kind: 'link', to: `/moves?coin=${enc(coin)}`, title: 'the moves table' })
  return actions
}

export const PART_LABEL: Record<QueueSource, string> = { moves: 'MOVES', opportunity: 'SETUP', radar: 'RADAR' }

/** `IN QUEUE · 14M` / `IN QUEUE · DISMISSED · 2H` / `not in today's queue`; null while the queue is unknown. */
export function queueHeadline(item: QueueItem | null | undefined, now: number): string | null {
  if (item === undefined) return null
  if (item === null) return "not in today's queue"
  const age = fmtDur((now - Date.parse(item.firstAt)) / 1000)
  return ['IN QUEUE', ...(item.state === 'new' ? [] : [item.state.toUpperCase()]), age].join(' · ')
}

export interface PartLine { key: string; label: string; direction: string | null; reason: string; to: string | null }
/** One line per source part: label, side, the facts-only reason and its own drill-in (none when it is this page). */
export function queuePartsLine(item: QueueItem | null | undefined, coin: string): PartLine[] {
  if (!item) return []
  return item.parts.map((p: QueuePart) => ({
    key: `${p.source}:${p.ref}`,
    label: PART_LABEL[p.source],
    direction: p.direction,
    reason: p.reason,
    to: p.href && p.href !== coinHref(coin) ? p.href : null,
  }))
}

/** What the move-detail poll resolved to: the detail, or one reason line in its place. */
export type DetailOutcome = { detail: MoveDetail; reason: null } | { detail: null; reason: string }

export function detailOutcome(d: MoveDetail): DetailOutcome {
  return d.state === 'ok' ? { detail: d, reason: null } : { detail: null, reason: d.reason ?? `${d.coin} detail unavailable` }
}

/** A 400 (not a main-dex perp name) or 404 (not listed) is the coin's reason line, not an error block. */
export function rejectedDetail(status: number | undefined, message: string, coin: string): DetailOutcome | null {
  if (status === 400 || status === 404) return { detail: null, reason: message || `${coin}: no move detail` }
  return null
}
