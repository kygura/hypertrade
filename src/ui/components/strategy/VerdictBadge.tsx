import { Badge } from '../Badge'
import type { VerdictStatus } from '../../../shared/strategy-protocol'
import { VERDICT_TONE } from './format'

// VerdictBadge — governor/operator/venue status of an intent. The word is
// always printed; the tone only reinforces it.

export function VerdictBadge({ status, className = '' }: { status: VerdictStatus; className?: string }) {
  return (
    <Badge tone={VERDICT_TONE[status]} className={className}>
      {status}
    </Badge>
  )
}
