import { EmptyBlock } from '../../components/state'
import type { QueueItem } from '../../../shared/queue'

export interface CoinDecisionProps {
  coin: string
  /** The coin's queue item when it is in today's queue (home passes it; CoinPage looks it up). */
  item?: QueueItem | null
  /** Why an investigation cannot run (QueueResponse.agentBlockedReason); null when it can. */
  blocked?: string | null
  /** pane: one column, no ← QUEUE (home right pane). page: the /coin route. */
  layout?: 'page' | 'pane'
}

export function CoinDecision({ coin }: CoinDecisionProps) {
  return <EmptyBlock label={coin} />
}
