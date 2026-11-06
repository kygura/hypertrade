import type { ReactNode } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'
import { Button } from './Button'
import { api, useApi } from '../lib/api'

// AppShell — docs/design/README.md §5. TopBar (>=768) / TopStrip + bottom tab bar
// (<768) via CSS breakpoints only, no JS matchMedia. NAV is two cells: the live
// MARKET read and RESEARCH (the Lab). Parked pages (the TRADE family at /feed,
// /terminal..., ENGINE, ASK, SECTORS/STATE/CYCLES, BRANCHES) stay reachable by URL.

export const NAV = [
  // MARKET: the landing (/) and every coin page (/markets/:coin).
  { to: '/', label: 'MARKET', tab: 'MKT', glyph: '≋' },
  // RESEARCH: heuristic research (docs/design/README.md §10.9); /lab/* switches inside via LabTabs.
  { to: '/lab', label: 'RESEARCH', tab: 'RSRCH', glyph: '⚗' },
]

export function isActive(pathname: string, to: string): boolean {
  if (to === '/') return pathname === '/' || pathname.startsWith('/markets/')
  if (to === '/lab') return pathname === '/lab' || pathname.startsWith('/lab/')
  return pathname === to || pathname.startsWith(`${to}/`)
}

export function AppShell({ children }: { children: ReactNode }) {
  const { pathname } = useLocation()
  const navigate = useNavigate()
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
