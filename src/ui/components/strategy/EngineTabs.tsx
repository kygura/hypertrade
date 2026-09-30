import { Link, useLocation } from 'react-router'

// EngineTabs — sub-navigation for the strategy console. The shell keeps one
// nav entry (ENGINE → /strategies) so the mobile tab bar stays at six cells;
// the three console routes switch here with the .tab-active idiom.

const TABS = [
  { to: '/strategies', label: 'STRATEGIES' },
  { to: '/decisions', label: 'DECISIONS' },
  { to: '/governor', label: 'GOVERNOR' },
]

export function isEnginePath(pathname: string): boolean {
  return TABS.some((t) => pathname === t.to || pathname.startsWith(`${t.to}/`))
}

export function EngineTabs() {
  const { pathname } = useLocation()
  return (
    <nav aria-label="engine" className="subtabs flex items-center gap-3 border-b border-border mb-3">
      {TABS.map((t) => {
        const active = pathname === t.to || pathname.startsWith(`${t.to}/`)
        return (
          <Link
            key={t.to}
            to={t.to}
            aria-current={active ? 'page' : undefined}
            className={`subtab h-[var(--control-md)] inline-flex items-center px-1 text-[10px] font-control [text-transform:var(--control-case)] tracking-[var(--control-tracking)] font-[number:var(--control-weight)] ${
              active ? 'tab-active' : 'text-text-secondary hover:text-text-primary'
            }`}
          >
            {t.label}
          </Link>
        )
      })}
    </nav>
  )
}
