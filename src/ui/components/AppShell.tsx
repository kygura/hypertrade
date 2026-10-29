import type { ReactNode } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'
import { Button } from './Button'
import { StatusDot, type DotStatus } from './Badge'
import { api, useApi } from '../lib/api'
import { isEnginePath } from './strategy/EngineTabs'
import { isTerminalPath } from './intel/TerminalTabs'
import { isMarketPath } from './market/MarketTabs'
import { ThemeSwitcher } from './ThemeSwitcher'

// AppShell — docs/design/README.md §5. TopBar (>=768) / TopStrip + bottom tab bar
// (<768) via CSS breakpoints only, no JS matchMedia. NAV is 5 cells, under the
// 9-cell ceiling (docs/CONSOLIDATION.md); every cell shows in the tab bar. Freshness cluster reads
// the most recent hl.total_oi_usd observation as a representative collector
// heartbeat: green <30min, amber 30min-2h, red >2h or fetch failed.

export const NAV = [
  // TRADE family (docs/CONSOLIDATION.md): Intel -> Act. /terminal, /watch, /journal,
  // /theses, /query, / (feed), /order and /desk switch inside via TerminalTabs.
  { to: '/', label: 'TRADE', tab: 'TRADE', glyph: '◉' },
  // MARKET family: /markets, /sectors, /state, /cycles (and their drills) switch
  // inside via MarketTabs; /overview redirects to /markets.
  { to: '/markets', label: 'MARKET', tab: 'MKT', glyph: '≋' },
  // RESEARCH family: heuristic research (docs/design/README.md §10.9) and the
  // Branches simulator; /lab/* and /branches/* switch inside via LabTabs.
  { to: '/lab', label: 'RESEARCH', tab: 'RSRCH', glyph: '⚗' },
  // Read-only LLM analyst (docs/SPEC.md "Analyst").
  { to: '/analyst', label: 'ASK', tab: 'ASK', glyph: '?' },
  // Strategy console: /strategies, /decisions and /governor switch inside via EngineTabs.
  { to: '/strategies', label: 'ENGINE', tab: 'ENGIN', glyph: '⚙' },
]

export function isActive(pathname: string, to: string): boolean {
  if (to === '/') return isTerminalPath(pathname)
  if (to === '/strategies') return isEnginePath(pathname)
  if (to === '/markets') return isMarketPath(pathname)
  if (to === '/lab') return pathname === '/lab' || pathname.startsWith('/lab/') || pathname === '/branches' || pathname.startsWith('/branches/')
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
  // Route-guard probe: a 401 redirects to /login (api.ts). In PUBLIC_MODE the
  // server lets visitors through as guests, so offer LOGIN instead of LOGOUT.
  const me = useApi<{ ok: boolean; guest?: boolean }>('/auth/me')

  const logout = async () => {
    await api.post('/auth/logout').catch(() => {})
    navigate('/login')
  }

  return (
    <div className="min-h-dvh flex flex-col">
      <header className="app-topbar sticky top-0 z-40 h-[var(--topbar-h)] flex items-center justify-between px-3 border-b border-border bg-topbar">
        <Link to="/" className="app-wordmark flex items-center gap-1.5 text-sm uppercase font-semibold tracking-wider font-display">
          HYPERTRADE
          <span className="app-wordmark-dot inline-block w-1.5 h-1.5 bg-accent" />
        </Link>

        <nav className="app-nav hidden md:flex items-center gap-3">
          {NAV.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              aria-current={isActive(pathname, item.to) ? 'page' : undefined}
              className={`app-nav-link text-xs font-control [text-transform:var(--control-case)] tracking-[var(--control-tracking)] font-[number:var(--control-weight)] pb-1 ${
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
            <span className="text-xs text-text-secondary tabular">{freshness.label}</span>
          </span>
          {me.data?.guest ? (
            <Button tier="ghost" onClick={() => navigate('/login')}>
              LOGIN
            </Button>
          ) : (
            <Button tier="ghost" onClick={logout}>
              LOGOUT
            </Button>
          )}
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
              <span className="text-md leading-none">{item.glyph}</span>
              <span className="text-2xs font-control [text-transform:var(--control-case)] tracking-[min(var(--control-tracking),0.02em)] font-[number:var(--control-weight)]">{item.tab}</span>
            </Link>
          )
        })}
      </nav>
    </div>
  )
}
