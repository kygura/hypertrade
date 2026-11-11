import { QueueItemSchema, QueueResponseSchema, type QueueItem, type QueueResponse } from '../../../shared/queue'

// Queue fixtures, parsed with the shared schemas so a contract change fails here first. Test-only: nothing in the
// app imports this file.

export const NOW = Date.parse('2026-11-11T14:20:00.000Z')
const DAY = '2026-11-11'

export function item(coin: string, over: Partial<QueueItem> = {}): QueueItem {
  return QueueItemSchema.parse({
    id: `${DAY}:${coin}`, day: DAY, coin, reason: 'residual +6.2% · z +3.1 · 24h · no news in window', score: 1.24,
    firstAt: '2026-11-11T14:06:00.000Z', lastAt: '2026-11-11T14:06:00.000Z', state: 'new', dismissedAt: null,
    parts: [{ source: 'moves', ref: `${DAY}:${coin}`, direction: null, reason: 'residual +6.2% · z +3.1 · 24h · no news in window', score: 1.24, at: '2026-11-11T14:06:00.000Z', actedAt: null, href: `/moves?coin=${coin}` }],
    record: null, href: `/coin/${coin}`,
    ...over,
  })
}

export const setupPart = (coin: string) => ({
  source: 'opportunity' as const, ref: '00000000-0000-4000-8000-000000000001', direction: 'long' as const, reason: 'crowded_short long · ready · net 42 bps',
  score: 1, at: '2026-11-11T14:10:00.000Z', actedAt: null, href: `/feed?id=00000000-0000-4000-8000-000000000001&coin=${coin}`,
})

export function queueResponse(over: Partial<QueueResponse> = {}): QueueResponse {
  const ok = (count: number) => ({ state: 'ok' as const, reason: null, count })
  return QueueResponseSchema.parse({
    asOf: '2026-11-11T14:20:00.000Z', day: DAY, cap: 8, overCap: 0,
    sources: { moves: ok(2), opportunity: ok(1), radar: ok(0) },
    agentRuns: 2, agentCap: 6, agentBlockedReason: null,
    items: [],
    ...over,
  })
}
