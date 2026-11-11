import { SectionTabs, tabMatches, type SectionTab } from '../SectionTabs'

// MarketTabs — the first family's row (docs/RESEARCH.md "Nav"): QUEUE, MOVES and VECTOR. MARKETS, SECTORS, STATE and
// CYCLES are hidden from the row (docs/TASKS.md 2026-11-11) and show only on their own pages.
// Drills (/cycles/:coin) stay on their tab via the prefix match.

export const MARKET_TABS: readonly SectionTab[] = [
  { to: '/queue', label: 'QUEUE', short: 'QUE', match: (p) => p === '/queue' || p.startsWith('/coin/') },
  { to: '/moves', label: 'MOVES', short: 'MOVE' },
  { to: '/vector', label: 'VECTOR', short: 'VECT' },
  { to: '/markets', label: 'MARKETS', short: 'MKTS', hidden: true },
  { to: '/sectors', label: 'SECTORS', short: 'SECT', hidden: true },
  { to: '/state', label: 'STATE', short: 'STATE', hidden: true },
  { to: '/cycles', label: 'CYCLES', short: 'CYCL', hidden: true },
]

/** True on every route of the MOVES family, hidden pages and drills included. */
export function isMarketPath(pathname: string): boolean {
  return MARKET_TABS.some((t) => tabMatches(t, pathname))
}

export function MarketTabs() {
  return <SectionTabs label="market sections" tabs={MARKET_TABS} />
}
