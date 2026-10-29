import type { ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { Segmented } from './Segmented'

// SectionTabs — the one sub-nav row of a family (docs/design/README.md §5, §10.9).
// A Segmented (md) sticky under the top bar (--topbar-h), --subnav-h tall,
// path-based so each tab is a bookmarkable page. TerminalTabs, MarketTabs and
// LabTabs are thin wrappers. Mobile: keep short labels ≤ 4 chars; overflow-x
// stays only as a safety net.

export interface SectionTab {
  to: string
  label: ReactNode
  /** Shorter label shown below md. */
  short?: ReactNode
  title?: string
  /** Which pathnames select this tab; default: `to` or a sub-path of it. */
  match?: (pathname: string) => boolean
  /** A status dot before the label: green when true, dim when false, none when omitted. */
  dot?: boolean
}

export function tabMatches(tab: SectionTab, pathname: string): boolean {
  return tab.match ? tab.match(pathname) : pathname === tab.to || pathname.startsWith(`${tab.to}/`)
}

export function SectionTabs({ label, tabs }: { label: string; tabs: readonly SectionTab[] }) {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const current = (tabs.find((t) => tabMatches(t, pathname)) ?? tabs[0])?.to ?? ''
  const options = tabs.map((t) => ({
    value: t.to,
    short: t.short,
    title: t.title,
    label:
      t.dot === undefined ? (
        t.label
      ) : (
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className={`inline-block w-1.5 h-1.5 ${t.dot ? 'bg-green' : 'bg-text-secondary/40'}`} />
          {t.label}
        </span>
      ),
  }))
  return (
    <div className="sticky top-[var(--topbar-h)] z-30 h-[var(--subnav-h)] flex items-center bg-body overflow-x-auto">
      <Segmented label={label} size="md" options={options} value={current} onChange={(to) => navigate(to)} />
    </div>
  )
}
