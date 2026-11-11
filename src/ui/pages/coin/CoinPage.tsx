import { useParams } from 'react-router'
import { usePoll } from '../../lib/poll'
import { queue, QUEUE_POLL_MS } from '../../lib/queue'
import { CoinDecision } from './CoinDecision'

// `/coin/:coin` (PLAN2 §2.3): the coin's decide page. Looks the coin up in today's queue (one poll) so the IN QUEUE
// parts and the agent-blocked reason show; a failing queue leaves the item unknown (no line), never an error block.
// HL coin names are case-sensitive (`kPEPE`, `xyz:TSLA`): the param is passed as-is.

export function CoinPage() {
  const { coin = '' } = useParams()
  const q = usePoll(queue.get, [], { intervalMs: QUEUE_POLL_MS })
  const item = q.data ? (q.data.items.find((i) => i.coin === coin) ?? null) : undefined
  return <CoinDecision key={coin} coin={coin} item={item} blocked={q.data?.agentBlockedReason ?? null} />
}
