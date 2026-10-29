import { VenueBadge } from './VenueBadge'
import type { DeskVenue } from './order'

// OrderBanner — DESIGN-terminal §7.1 item 1. Persistent, not dismissible, all
// breakpoints: the order path is operator-only and Desk-venue-only. The venue
// line under it (red) appears when the Desk status is unknown or refused.

export function OrderBanner({ venue, venueError }: { venue: DeskVenue | null; venueError?: string | null }) {
  return (
    <div role="note" aria-label="order safety" className="bg-panel-alt border border-border px-3 py-2 flex flex-col gap-1">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-text-muted">
        <VenueBadge venue={venue} />
        <span>
          Operator orders only — preview, then your confirm, then the Desk venue. No autonomous execution. Paper or testnet
          only. Mainnet is refused.
        </span>
      </p>
      {venueError && <p className="text-xs text-red-text">{venueError}</p>}
    </div>
  )
}
