import { useLocation, useNavigate } from 'react-router'
import { Segmented, type SegmentOption } from '../Segmented'

// TerminalTabs — DESIGN-terminal §1.3. One Segmented (md) under the shell,
// the LabTabs pattern: sticky under the 40px top bar, 52px row, path-based
// (changing a segment navigates). Order: the review, the operator's own
// record, the tools, the old glance. No count suffixes (a fetch per route).
// Mobile: seven ≤ 4-char short labels fit at 320px; overflow-x stays only as
// a safety net (wider theme --seg-pad, 200% zoom).

export type TerminalTab = 'terminal' | 'journal' | 'theses' | 'query' | 'order' | 'watch' | 'overview'

export const TERMINAL_TABS: readonly (SegmentOption<TerminalTab> & { path: string; title: string })[] = [
  { value: 'terminal', path: '/', label: 'TERMINAL', short: 'TERM', title: 'what changed since I last looked' },
  { value: 'journal', path: '/journal', label: 'JOURNAL', short: 'JRNL', title: 'what my trades say' },
  { value: 'theses', path: '/theses', label: 'THESES', short: 'THES', title: 'test a thesis against the data' },
  { value: 'query', path: '/query', label: 'QUERY', short: 'QRY', title: 'ask the snapshot store' },
  { value: 'order', path: '/order', label: 'ORDER', short: 'ORDR', title: 'preview and place a Desk order' },
  { value: 'watch', path: '/watch', label: 'WATCH', short: 'WTCH', title: 'watch docs, contracts and wallets' },
  { value: 'overview', path: '/overview', label: 'OVERVIEW', short: 'OVW', title: 'market glance' },
]

/** The Terminal-family tab a path belongs to, or null outside the family. */
export function terminalTabOf(pathname: string): TerminalTab | null {
  // `/asset/:coin` is a drill-in of `/` (DESIGN-terminal §15.4).
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
  const { pathname } = useLocation()
  const navigate = useNavigate()
  return (
    <div className="sticky top-10 z-30 h-[52px] flex items-center bg-body overflow-x-auto">
      <Segmented
        label="terminal sections"
        size="md"
        options={TERMINAL_TABS}
        value={terminalTabOf(pathname) ?? 'terminal'}
        onChange={(t) => navigate(TERMINAL_TABS.find((x) => x.value === t)!.path)}
      />
    </div>
  )
}
