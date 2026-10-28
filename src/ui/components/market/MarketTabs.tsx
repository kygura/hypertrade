import { SectionTabs, type SectionTab } from '../SectionTabs'

// MarketTabs — the MARKET family row (docs/CONSOLIDATION.md PR 3): perps, sectors,
// state, cycles. Drills (/cycles/:coin) stay on their tab via the prefix match.

export const MARKET_TABS: readonly SectionTab[] = [
  { to: '/markets', label: 'PERPS', short: 'PERP' },
  { to: '/sectors', label: 'SECTORS', short: 'SECT' },
  { to: '/state', label: 'STATE', short: 'STATE' },
  { to: '/cycles', label: 'CYCLES', short: 'CYCL' },
]

/** True on every route of the MARKET family, drills included. */
export function isMarketPath(pathname: string): boolean {
  return MARKET_TABS.some((t) => pathname === t.to || pathname.startsWith(`${t.to}/`))
}

export function MarketTabs() {
  return <SectionTabs label="market sections" tabs={MARKET_TABS} />
}
