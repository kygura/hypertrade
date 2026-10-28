import type { SegmentOption } from '../Segmented'
import { SectionTabs } from '../SectionTabs'

// TerminalTabs — the TRADE tab row (docs/CONSOLIDATION.md "Target nav"). A
// SectionTabs wrapper: sticky under the top bar, path-based. Order is a funnel
// from intel (CHANGES, WATCH, JOURNAL, THESES, QUERY) to act (FEED, ORDER, DESK);
// SectionTabs has no group separator, so the order alone carries it. No count
// suffixes (a fetch per route). Mobile: eight ≤ 4-char short labels.

export type TerminalTab = 'terminal' | 'watch' | 'journal' | 'theses' | 'query' | 'cockpit' | 'order' | 'desk'

export const TERMINAL_TABS: readonly (SegmentOption<TerminalTab> & { path: string; title: string })[] = [
  { value: 'terminal', path: '/terminal', label: 'CHANGES', short: 'CHNG', title: 'what changed since I last looked' },
  { value: 'watch', path: '/watch', label: 'WATCH', short: 'WTCH', title: 'watch docs, contracts and wallets' },
  { value: 'journal', path: '/journal', label: 'JOURNAL', short: 'JRNL', title: 'what my trades say' },
  { value: 'theses', path: '/theses', label: 'THESES', short: 'THES', title: 'test a thesis against the data' },
  { value: 'query', path: '/query', label: 'QUERY', short: 'QRY', title: 'ask the snapshot store' },
  { value: 'cockpit', path: '/', label: 'FEED', short: 'FEED', title: 'what to act on now' },
  { value: 'order', path: '/order', label: 'ORDER', short: 'ORDR', title: 'preview and place a Desk order' },
  { value: 'desk', path: '/desk', label: 'DESK', short: 'DESK', title: 'agent team, governor and paper book' },
]

/** The TRADE-family tab a path belongs to, or null outside the family. */
export function terminalTabOf(pathname: string): TerminalTab | null {
  // `/asset/:coin` is a drill-in of `/terminal` (docs/design/terminal.md §15.4, C1).
  if (pathname.startsWith('/asset/')) return 'terminal'
  for (const t of TERMINAL_TABS) {
    if (t.path === '/' ? pathname === '/' : pathname === t.path || pathname.startsWith(`${t.path}/`)) return t.value
  }
  return null
}

/** True on every route of the TRADE family (the shell's TRADE entry is active there). */
export function isTerminalPath(pathname: string): boolean {
  return terminalTabOf(pathname) !== null
}

export function TerminalTabs() {
  return (
    <SectionTabs
      label="trade sections"
      tabs={TERMINAL_TABS.map((t) => ({
        to: t.path,
        label: t.label,
        short: t.short,
        title: t.title,
        match: (p) => terminalTabOf(p) === t.value,
      }))}
    />
  )
}

export const TradeTabs = TerminalTabs
