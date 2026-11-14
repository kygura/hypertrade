import type { SegmentOption } from '../Segmented'
import { SectionTabs } from '../SectionTabs'

// TerminalTabs — the TRADE tab row (docs/RESEARCH.md "Nav"): DESK, ORDER, JOURNAL. A
// SectionTabs wrapper: sticky under the top bar, path-based. FEED, CHANGES, WATCH, THESES and
// QUERY are hidden from the row (docs/TASKS.md 2026-11-11): their routes still work and each
// shows its own tab only while it is open. No count suffixes (a fetch per route).

export type TerminalTab = 'terminal' | 'watch' | 'journal' | 'theses' | 'query' | 'cockpit' | 'order' | 'desk'

export const TERMINAL_TABS: readonly (SegmentOption<TerminalTab> & { path: string; title: string; hidden?: boolean })[] = [
  { value: 'desk', path: '/desk', label: 'DESK', short: 'DESK', title: 'agent team, governor and paper book' },
  { value: 'order', path: '/order', label: 'ORDER', short: 'ORDR', title: 'preview and place a Desk order' },
  { value: 'journal', path: '/journal', label: 'JOURNAL', short: 'JRNL', title: 'what my trades say' },
  { value: 'cockpit', path: '/feed', label: 'FEED', short: 'FEED', title: 'what to act on now', hidden: true },
  { value: 'terminal', path: '/terminal', label: 'CHANGES', short: 'CHNG', title: 'what changed since I last looked', hidden: true },
  { value: 'watch', path: '/watch', label: 'WATCH', short: 'WTCH', title: 'watch docs, contracts and wallets', hidden: true },
  { value: 'theses', path: '/theses', label: 'THESES', short: 'THES', title: 'test a thesis against the data', hidden: true },
  { value: 'query', path: '/query', label: 'QUERY', short: 'QRY', title: 'ask the snapshot store', hidden: true },
]

/** The TRADE-family tab a path belongs to, or null outside the family. */
export function terminalTabOf(pathname: string): TerminalTab | null {
  // `/asset/:coin` is a drill-in of `/terminal` (docs/design/terminal.md §15.4, C1).
  if (pathname.startsWith('/asset/')) return 'terminal'
  for (const t of TERMINAL_TABS) {
    if (pathname === t.path || pathname.startsWith(`${t.path}/`)) return t.value
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
        hidden: t.hidden,
        match: (p) => terminalTabOf(p) === t.value,
      }))}
    />
  )
}
