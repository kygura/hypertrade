import type { ReactNode } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'
import { Button } from './Button'
import { StatusDot, type DotStatus } from './Badge'
import { api, useApi } from '../lib/api'
import { isEnginePath } from './strategy/EngineTabs'
import { ThemeSwitcher } from './ThemeSwitcher'

// AppShell — DESIGN.md §5. TopBar (>=768) / TopStrip + bottom tab bar
// (<768) via CSS breakpoints only, no JS matchMedia. Freshness cluster reads
// the most recent hl.total_oi_usd observation as a representative collector
// heartbeat: green <30min, amber 30min-2h, red >2h or fetch failed.

const NAV = [
  { to: '/', label: 'OVERVIEW', tab: 'OVIEW', glyph: '◈' },
  { to: '/branches', label: 'BRANCHES', tab: 'BRNCH', glyph: '⑂' },
  { to: '/sectors', label: 'SECTORS', tab: 'SECTR', glyph: '▦' },
  { to: '/state', label: 'STATE', tab: 'STATE', glyph: '☰' },
  { to: '/markets', label: 'MARKETS', tab: 'MKTS', glyph: '≋' },
  // Strategy console: one shell entry so the mobile tab bar stays compact;
  // /strategies, /decisions and /governor switch inside via EngineTabs.
  { to: '/strategies', label: 'ENGINE', tab: 'ENGIN', glyph: '⚙' },
  // Read-only LLM analyst (SPEC.md "Analyst"); a seventh cell on mobile.
  // Open-data rule research (SPEC.md "Lab"); the eighth cell on mobile.
  { to: '/lab', label: 'LAB', tab: 'LAB', glyph: 'Σ' },
  { to: '/analyst', label: 'ANALYST', tab: 'ASK', glyph: '?' },
]

function isActive(pathname: string, to: string): boolean {
  if (to === '/') return pathname === '/'
  if (to === '/strategies') return isEnginePath(pathname)
  return pathname === to || pathname.startsWith(`${to}/`)
}

function useFreshness(): { status: DotStatus; label: string } {
  const { data, error } = useApi<{ ts: string | null }[]>('/metrics/summary?ids=hl.total_oi_usd')
  if (error) return { status: 'down', label: 'DATA —' }
  const ts = data?.[0]?.ts
  if (!ts) return { status: 'unknown', label: 'DATA —' }
  const ageMin = (Date.now() - new Date(ts).getTime()) / 60_000
  const status: DotStatus = ageMin < 30 ? 'ok' : ageMin < 120 ? 'degraded' : 'down'
  const label = `DATA ${new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`
  return { status, label }
}

export function AppShell({ children }: { children: ReactNode }) {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const freshness = useFreshness()

  const logout = async () => {
    await api.post('/auth/logout').catch(() => {})
    navigate('/login')
  }

  return (
    <div className="min-h-dvh flex flex-col">
      <header className="app-topbar sticky top-0 z-40 h-10 flex items-center justify-between px-3 border-b border-border bg-topbar">
        <Link to="/" className="app-wordmark flex items-center gap-1.5 text-[11px] uppercase font-semibold tracking-wider font-display">
          HYPERTRADE
          <span className="app-wordmark-dot inline-block w-1.5 h-1.5 bg-accent" />
        </Link>

        <nav className="app-nav hidden md:flex items-center gap-3">
          {NAV.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              aria-current={isActive(pathname, item.to) ? 'page' : undefined}
              className={`app-nav-link text-[10px] font-control [text-transform:var(--control-case)] tracking-[var(--control-tracking)] font-[number:var(--control-weight)] pb-1 ${
                isActive(pathname, item.to) ? 'tab-active' : 'text-text-secondary hover:text-text-primary'
              }`}
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="flex items-center gap-3">
          <ThemeSwitcher />
          <span className="hidden md:flex items-center gap-1.5" title="last collector run (hl.total_oi_usd)">
            <StatusDot status={freshness.status} />
            <span className="text-[10px] text-text-secondary tabular">{freshness.label}</span>
          </span>
          <Button tier="ghost" onClick={logout}>
            LOGOUT
          </Button>
        </div>
      </header>

      <main className="flex-1 pb-[calc(56px+env(safe-area-inset-bottom))] md:pb-0">{children}</main>

      <nav
        aria-label="primary"
        className="app-tabbar md:hidden fixed bottom-0 left-0 right-0 z-40 flex bg-topbar border-t border-border"
        style={{ height: 'calc(56px + env(safe-area-inset-bottom))', paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        {NAV.map((item) => {
          const active = isActive(pathname, item.to)
          return (
            <Link
              key={item.to}
              to={item.to}
              aria-current={active ? 'page' : undefined}
              className={`app-tab flex-1 flex flex-col items-center justify-center gap-0.5 border-t-2 ${
                active ? 'border-accent text-text-primary' : 'border-transparent text-text-secondary'
              }`}
            >
              <span className="text-[12px] leading-none">{item.glyph}</span>
              <span className="text-[9px] font-control [text-transform:var(--control-case)] tracking-[var(--control-tracking)] font-[number:var(--control-weight)]">{item.tab}</span>
            </Link>
          )
        })}
      </nav>
    </div>
  )
}
