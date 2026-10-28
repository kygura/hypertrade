import type { Catalyst } from '../../../shared/intel'
import { Badge } from '../Badge'
import { Button } from '../Button'
import { fmtTs } from '../strategy/format'
import { fmtCountdown, hoursUntil } from './format'
import { SourceLink } from './SourceLink'

// CatalystRow — DESIGN-terminal §3.6. Countdown (amber < 24 h, title = UTC),
// title, asset tags with HELD/WATCH, origin badge, size, the direction
// hypothesis as a HYP badge + words (never green/red, SPEC I0.13), source.
// Manual rows get a Danger ✕ (the panel owns the Level 2 confirm).

const ORIGIN_LABEL: Partial<Record<Catalyst['origin'], string>> = {
  manual: 'MANUAL',
  governance: 'GOV',
  calendar: 'MACRO',
  websearch: 'SWEEP',
}

const DIRECTION_WORDS = { up: 'upside pressure', down: 'supply overhang', unclear: 'direction unclear' } as const

export function CatalystRow({
  catalyst,
  held,
  watched,
  now,
  onDelete,
}: {
  catalyst: Catalyst
  held: Set<string>
  watched: Set<string>
  now: number
  onDelete?: () => void
}) {
  const soon = hoursUntil(catalyst.scheduledAt, now) < 24
  const dir = catalyst.catalyst?.directionHypothesis
  const size = catalyst.catalyst?.size
  const source = catalyst.sources[0]

  return (
    <li className="flex items-start gap-3 px-3 py-2 border-b border-border-subtle last:border-b-0">
      <span className={`w-[9ch] flex-shrink-0 text-md tabular ${soon ? 'text-amber' : 'text-text-primary'}`} title={fmtTs(catalyst.scheduledAt)}>
        {fmtCountdown(catalyst.scheduledAt, now)}
      </span>
      <div className="min-w-0 flex-1 flex flex-col gap-1">
        <span className="text-md text-text-primary break-words">{catalyst.title}</span>
        <span className="flex flex-wrap items-center gap-1.5 text-xs">
          {catalyst.assets.map((a) => (
            <span key={a} className="inline-flex items-baseline gap-1 whitespace-nowrap">
              <span className="text-2xs uppercase tracking-wider text-text-primary">{a}</span>
              {held.has(a) ? (
                <span className="text-2xs uppercase tracking-wider text-text-primary">HELD</span>
              ) : watched.has(a) ? (
                <span className="text-2xs uppercase tracking-wider text-text-secondary">WATCH</span>
              ) : null}
            </span>
          ))}
          <Badge tone="gray">{ORIGIN_LABEL[catalyst.origin] ?? catalyst.origin.toUpperCase()}</Badge>
          {size && <span className="text-text-muted">{size}</span>}
          {dir && (
            <span className="inline-flex items-center gap-1" title="inference by the model — not an observed fact">
              <Badge tone="info">HYP</Badge>
              <span className="text-text-muted">{DIRECTION_WORDS[dir]}</span>
            </span>
          )}
          {source && <SourceLink source={source} />}
        </span>
      </div>
      {onDelete && (
        <Button tier="danger" aria-label={`delete catalyst ${catalyst.title}`} onClick={onDelete} className="flex-shrink-0">
          ✕
        </Button>
      )}
    </li>
  )
}
