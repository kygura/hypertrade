import { AssetSchema } from '../../../shared/intel'
import type { QueueItem } from '../../../shared/queue'

// What the ASK drawer already knows about where the trader is: the coin on screen (from the URL) and, when it is in
// today's queue, that item's own facts. Pure; the prefix is sent with the question, the thread shows the user's text.

export const ASK_MAX = 4000 // the /api/analyst `question` max

export interface AskContext {
  coin: string
  item?: QueueItem | null
}

function coinOrNull(raw: string | null | undefined): string | null {
  if (!raw) return null
  let v = raw
  try {
    v = decodeURIComponent(raw)
  } catch {
    // A malformed escape keeps the raw text; the schema decides.
  }
  const r = AssetSchema.safeParse(v)
  return r.success ? r.data : null
}

/** `/coin/:c`, `/markets/:c`, `/asset/:c`, and `?coin=` on `/queue`, `/moves`, `/board`; anything else → null. */
export function askContextOf(pathname: string, search: string): { coin: string } | null {
  const seg = /^\/(coin|markets|asset)\/([^/]+)\/?$/.exec(pathname)
  if (seg) {
    const coin = coinOrNull(seg[2])
    return coin ? { coin } : null
  }
  if (/^\/(queue|moves|board)\/?$/.test(pathname)) {
    const coin = coinOrNull(new URLSearchParams(search).get('coin'))
    return coin ? { coin } : null
  }
  return null
}

function facts(ctx: AskContext): string {
  const parts = [`coin ${ctx.coin}`]
  const item = ctx.item
  if (item) {
    parts.push(`in queue: ${item.reason}`)
    const r = item.record
    if (r?.claim) parts.push(`agent record: ${r.claim}`)
    if (r?.falsifier) parts.push(`falsifier ${r.falsifier.side} ${r.falsifier.level}`)
  }
  return parts.join(' · ')
}

/** `[context: …]\n` + question, whole ≤ ASK_MAX; the facts are cut (or dropped) before the question is. No context → the question unchanged. */
export function withContext(question: string, ctx: AskContext | null): string {
  if (!ctx) return question
  const budget = ASK_MAX - question.length - '[context: ]\n'.length
  let f = facts(ctx)
  if (f.length > budget) f = budget >= 24 ? `${f.slice(0, budget - 1)}…` : ''
  return f ? `[context: ${f}]\n${question}` : question
}
