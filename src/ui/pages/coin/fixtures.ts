import { QueueItemSchema, type QueueItem } from '../../../shared/queue'
import { record } from '../moves/fixtures'

// COIN test fixtures: a queue item parsed with the shared schema (a contract drift fails here first). Test-only.

export function queueItem(over: Record<string, unknown> = {}): QueueItem {
  return QueueItemSchema.parse({
    id: '2026-11-11:HYPE', day: '2026-11-11', coin: 'HYPE', reason: 'residual +6.2% · z +3.1 · 24h · no news in window', score: 1.24,
    firstAt: '2026-11-11T14:06:00.000Z', lastAt: '2026-11-11T14:10:00.000Z', state: 'new', dismissedAt: null,
    parts: [
      { source: 'moves', ref: '2026-11-11:HYPE', direction: null, reason: 'residual +6.2% · z +3.1 · 24h · no news in window', score: 1.24, at: '2026-11-11T14:06:00.000Z', actedAt: null, href: '/moves?coin=HYPE' },
      { source: 'opportunity', ref: 'opp-1', direction: 'long', reason: 'crowded_short long · ready · net 42 bps', score: 1, at: '2026-11-11T14:10:00.000Z', actedAt: null, href: '/coin/HYPE' },
    ],
    record: record(),
    href: '/coin/HYPE',
    ...over,
  })
}
