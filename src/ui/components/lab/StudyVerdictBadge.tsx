import { Badge } from '../Badge'
import { studyVerdict, type EventVerdict } from '../../lib/study'

// The event-study verdict as text plus colour (docs/RESEARCH.md: clear = positive, rejected = negative,
// insufficient = muted; never colour alone). /lab/study and the research board both render it.
export function StudyVerdictBadge({ verdict }: { verdict: EventVerdict }) {
  const v = studyVerdict(verdict)
  return (
    <span title={v.text} className="inline-flex">
      <Badge tone={v.tone}>{v.label}</Badge>
    </span>
  )
}
