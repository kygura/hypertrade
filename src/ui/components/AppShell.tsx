import type { ReactNode } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'
import { Button } from './Button'
import { StatusDot, type DotStatus } from './Badge'
import { api, useApi } from '../lib/api'

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
]

function isActive(pathname: string, to: string): boolean {
  if (to === '/') return pathname === '/'
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
      <header className="sticky top-0 z-40 h-10 flex items-center justify-between px-3 border-b border-border bg-panel-alt">
        <Link to="/" className="flex items-center gap-1.5 text-[11px] uppercase font-semibold tracking-wider">
          HYPERTRADE
          <span className="inline-block w-1.5 h-1.5 bg-red-accent" />
        </Link>

        <nav className="hidden md:flex items-center gap-3">
          {NAV.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className={`text-[10px] uppercase tracking-wider pb-1 ${
                isActive(pathname, item.to) ? 'tab-active' : 'text-text-secondary hover:text-text-primary'
              }`}
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="flex items-center gap-3">
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
        className="md:hidden fixed bottom-0 left-0 right-0 z-40 flex bg-panel-alt border-t border-border"
        style={{ height: 'calc(56px + env(safe-area-inset-bottom))', paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        {NAV.map((item) => {
          const active = isActive(pathname, item.to)
          return (
            <Link
              key={item.to}
              to={item.to}
              aria-current={active ? 'page' : undefined}
              className={`flex-1 flex flex-col items-center justify-center gap-0.5 border-t-2 ${
                active ? 'border-red-accent text-text-primary' : 'border-transparent text-text-secondary'
              }`}
            >
              <span className="text-[12px] leading-none">{item.glyph}</span>
              <span className="text-[9px] uppercase tracking-wider">{item.tab}</span>
            </Link>
          )
        })}
      </nav>
    </div>
  )
}
