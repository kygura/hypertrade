import type { SegmentOption } from '../Segmented'
import { SectionTabs } from '../SectionTabs'

// TerminalTabs — docs/design/terminal.md §1.3. One Segmented (md) under the shell,
// a SectionTabs wrapper: sticky under the top bar (--topbar-h), --subnav-h row,
// path-based (changing a segment navigates). Order: the review, the operator's
// own record, the tools. No count suffixes (a fetch per route).
// Mobile: seven ≤ 4-char short labels fit at 320px; overflow-x stays only as
// a safety net (wider theme --seg-pad, 200% zoom).

export type TerminalTab = 'cockpit' | 'terminal' | 'journal' | 'theses' | 'query' | 'order' | 'watch'

export const TERMINAL_TABS: readonly (SegmentOption<TerminalTab> & { path: string; title: string })[] = [
  { value: 'cockpit', path: '/', label: 'COCKPIT', short: 'CKPT', title: 'what to act on now' },
  { value: 'terminal', path: '/terminal', label: 'TERMINAL', short: 'TERM', title: 'what changed since I last looked' },
  { value: 'journal', path: '/journal', label: 'JOURNAL', short: 'JRNL', title: 'what my trades say' },
  { value: 'theses', path: '/theses', label: 'THESES', short: 'THES', title: 'test a thesis against the data' },
  { value: 'query', path: '/query', label: 'QUERY', short: 'QRY', title: 'ask the snapshot store' },
  { value: 'order', path: '/order', label: 'ORDER', short: 'ORDR', title: 'preview and place a Desk order' },
  { value: 'watch', path: '/watch', label: 'WATCH', short: 'WTCH', title: 'watch docs, contracts and wallets' },
]

/** The Terminal-family tab a path belongs to, or null outside the family. */
export function terminalTabOf(pathname: string): TerminalTab | null {
  // `/asset/:coin` is a drill-in of `/terminal` (docs/design/terminal.md §15.4, C1).
  if (pathname.startsWith('/asset/')) return 'terminal'
  for (const t of TERMINAL_TABS) {
    if (t.path === '/' ? pathname === '/' : pathname === t.path || pathname.startsWith(`${t.path}/`)) return t.value
  }
  return null
}

/** True on every route of the Terminal family (the shell's TERMINAL entry is active there). */
export function isTerminalPath(pathname: string): boolean {
  return terminalTabOf(pathname) !== null
}

export function TerminalTabs() {
  return (
    <SectionTabs
      label="terminal sections"
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
