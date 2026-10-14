import { useState } from 'react'
import { useNavigate } from 'react-router'
import type { AssetEvent, Catalyst, FlowFlag } from '../../../shared/intel'
import { Badge } from '../Badge'
import { Button } from '../Button'
import { fmtTs } from '../strategy/format'
import { NoNarrationRow } from './AlertItem'
import { eventKey } from './AssetTimeline'
import { ClaimLine } from './ClaimLine'
import { flagWord, numbersLine } from './flow'
import { fmtCountdown, fmtMdHm } from './format'
import { statusTone, statusWord } from './research'
import { RESEARCH_ANCHOR } from './ResearchPanel'
import { ResearchCard } from './ResearchCard'
import { SourceLink } from './SourceLink'

// EventList — DESIGN-terminal §15.5. The labeled form of the price-pane
// markers, newest first: alerts as their ClaimLine (or the amber no-narration
// row), detector hits / flips / crossings as OBS + plain words + numbers
// line, catalysts as CATALYST + title. Upcoming catalysts lead with their T−
// countdown. Hover/focus a row → its marker turns text-primary.
// Research (§16.4): status Badge + RESEARCH + the question; with a payload the
// row is a disclosure (one open at a time, Esc collapses) opening the compact
// ResearchCard; without one it links back to the panel on `/`.

/** A flow event's words: code names (`crowded_long`, `funding>0.0000625`) go through the §15.3 copy; anything else prints verbatim. */
export function flowEventText(e: Pick<AssetEvent, 'title' | 'numbers'>): string {
  if (!/^[a-z0-9_]+([<>]\S+)?$/.test(e.title)) return e.title
  const f: Pick<FlowFlag, 'kind' | 'name' | 'numbers' | 'window'> = {
    kind: /[<>]/.test(e.title) ? 'crossing' : 'detector',
    name: e.title,
    numbers: e.numbers ?? {},
    window: '24h',
  }
  const nums = e.numbers ? numbersLine(f) : ''
  return [flagWord(f).toLowerCase(), nums].filter(Boolean).join(' · ')
}

export function EventList({
  events,
  upcoming,
  hot,
  onHover,
  now,
}: {
  /** Newest first. */
  events: AssetEvent[]
  /** Catalysts still ahead (not yet in `events`). */
  upcoming: Catalyst[]
  hot: string | null
  onHover: (key: string | null) => void
  now: number
}) {
  const navigate = useNavigate()
  const [open, setOpen] = useState<string | null>(null)
  return (
    <ul className="flex flex-col" onKeyDown={(e) => e.key === 'Escape' && setOpen(null)}>
      {upcoming.map((c) => (
        <li key={c.eventId} className="flex items-start gap-3 px-3 py-1.5 border-b border-border-subtle text-[12px]">
          <span className="w-[11ch] flex-shrink-0 text-[10px] tabular text-text-primary" title={fmtTs(c.scheduledAt)}>
            {fmtCountdown(c.scheduledAt, now)}
          </span>
          <span className="flex flex-wrap items-center gap-2 min-w-0">
            <Badge tone="gray">OBS</Badge>
            <span className="label">CATALYST</span>
            <span className="text-text-primary break-words">{c.title}</span>
          </span>
        </li>
      ))}
      {events.map((e) => {
        const k = eventKey(e)
        return (
          <li
            key={k}
            id={`event-${k}`}
            tabIndex={0}
            onMouseEnter={() => onHover(k)}
            onMouseLeave={() => onHover(null)}
            onFocus={() => onHover(k)}
            onBlur={() => onHover(null)}
            className={`flex items-start gap-3 px-3 py-1.5 border-b border-border-subtle last:border-b-0 text-[12px] ${hot === k ? 'bg-hover' : ''}`}
          >
            <span className="w-[11ch] flex-shrink-0 text-[10px] tabular text-text-secondary pt-0.5" title={fmtTs(e.ts)}>
              {fmtMdHm(e.ts)}
            </span>
            <div className="min-w-0 flex-1">
              {e.kind === 'research' ? (
                <>
                  <span className="flex flex-wrap items-center gap-2">
                    {e.research ? (
                      <button
                        type="button"
                        aria-expanded={open === k}
                        onClick={() => setOpen((o) => (o === k ? null : k))}
                        className="flex flex-wrap items-center gap-2 text-left"
                      >
                        <Badge tone={statusTone(e.research.status)}>{statusWord(e.research.status)}</Badge>
                        <span className="label">RESEARCH</span>
                        <span className="text-text-primary break-words">{e.title}</span>
                      </button>
                    ) : (
                      <>
                        <span className="label">RESEARCH</span>
                        <span className="text-text-primary break-words">{e.title}</span>
                        <Button tier="ghost" onClick={() => navigate(`/#${RESEARCH_ANCHOR}`)}>
                          SEE ON TERMINAL →
                        </Button>
                      </>
                    )}
                  </span>
                  {e.research && open === k && (
                    <div className="mt-1.5 -mx-3">
                      <ResearchCard result={e.research} compact />
                    </div>
                  )}
                </>
              ) : e.kind === 'alert' ? (
                e.claim ? (
                  <ClaimLine claim={e.claim} />
                ) : (
                  <NoNarrationRow />
                )
              ) : (
                <span className="flex flex-wrap items-center gap-2">
                  <Badge tone="gray">OBS</Badge>
                  {e.kind === 'catalyst' && <span className="label">CATALYST</span>}
                  <span className="text-text-primary tabular break-words">{e.kind === 'flow' ? flowEventText(e) : e.title}</span>
                  {e.url && <SourceLink source={{ label: 'source', url: e.url }} />}
                </span>
              )}
            </div>
          </li>
        )
      })}
    </ul>
  )
}
