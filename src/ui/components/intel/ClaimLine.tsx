import type { Claim, HypothesisClaim, ObservedClaim } from '../../../shared/claims'
import { Badge } from '../Badge'
import { fmtTs } from '../strategy/format'
import { ClaimAge } from './ClaimAge'
import { SourceLink, type SourceRef } from './SourceLink'

// ClaimLine — DESIGN-terminal §2.1. Every model-written line is a Claim:
// observed (text + source + ts) or hypothesis (text only). The two read apart
// at a glance, at 390px, in every theme, without color:
// - prefix column (4ch): gray `OBS` / info `HYP` Badge — the word is the signal;
// - text 12px: observed text-primary; hypothesis text-muted + a 2px info left
//   rule (inset shadow, no layout shift) + 6px padding. Never uppercased,
//   truncated or recolored;
// - observed only: SourceLink · ClaimAge, right-aligned on md+ when it fits,
//   else on its own line under the text (always own line on mobile). A
//   hypothesis prints nothing there; the empty slot is part of the signal.
// Rendered as <li> inside ClaimList; standalone (an alert's line, a note
// summary) it is a <div>.
// Research evidence (§16.2) widens this: an observed ts may be null (no
// ClaimAge), and a hypothesis may keep the url the provider saw — rendered
// inside the muted block after the text, never in the right-hand source slot.

export type LineClaim =
  | Claim
  | (Omit<ObservedClaim, 'ts'> & { ts: string | null })
  | (HypothesisClaim & { source?: SourceRef })

export function ClaimLine({ claim, as: Tag = 'div' }: { claim: LineClaim; as?: 'li' | 'div' }) {
  const observed = claim.tag === 'observed'
  return (
    <Tag className="claim-line flex items-start gap-2 text-md leading-snug" data-claim={claim.tag}>
      <span
        className="w-[4ch] flex-shrink-0 pt-px"
        title={observed ? `observed: ${claim.source.label}${claim.ts ? `, ${fmtTs(claim.ts)}` : ''}` : 'inference by the model — not an observed fact'}
      >
        <span aria-hidden="true">
          <Badge tone={observed ? 'gray' : 'info'}>{observed ? 'OBS' : 'HYP'}</Badge>
        </span>
        <span className="sr-only">{observed ? 'observed:' : 'hypothesis, model inference:'}</span>
      </span>
      {observed ? (
        <span className="min-w-0 flex-1 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
          <span className="basis-full md:basis-auto min-w-0 break-words text-text-primary">{claim.text}</span>
          <span className="inline-flex items-center gap-1 whitespace-nowrap">
            <SourceLink source={claim.source} />
            {claim.ts && (
              <>
                <span aria-hidden="true" className="text-xs text-text-secondary">
                  ·
                </span>
                <ClaimAge ts={claim.ts} />
              </>
            )}
          </span>
        </span>
      ) : (
        <span className="min-w-0 flex-1 break-words text-text-muted pl-1.5 shadow-[inset_2px_0_0_var(--color-info)]">
          {claim.text}
          {'source' in claim && claim.source && (
            <>
              {' '}
              <SourceLink source={claim.source} />
            </>
          )}
        </span>
      )}
    </Tag>
  )
}
