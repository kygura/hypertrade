import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'
import { Button } from './Button'
import { StatusDot, type DotStatus } from './Badge'
import { api, useApi } from '../lib/api'
import { isDbUnavailable } from '../lib/dbUnavailable'
import { isTerminalPath } from './intel/TerminalTabs'
import { isMarketPath } from './market/MarketTabs'
import { isResearchPath } from './lab/LabTabs'
import { ThemeSwitcher } from './ThemeSwitcher'
// The drawer pulls in the analyst thread and composer: its own chunk, fetched on the first open.
const AskDrawer = lazy(() => import('./ask/AskDrawer').then((m) => ({ default: m.AskDrawer })))

// AppShell — docs/design/README.md §5. TopBar (>=768) / TopStrip + bottom tab bar
// (<768) via CSS breakpoints only, no JS matchMedia. NAV is 3 cells, one per job
// (docs/RESEARCH.md "Nav"); every cell shows in the tab bar. ASK is a header button opening a drawer (also on the `ht:ask` window event), ENGINE has no entry. Freshness cluster reads
// the most recent hl.total_oi_usd observation as a representative collector
// heartbeat: green <30min, amber 30min-2h, red >2h or fetch failed.

export const NAV = [
  // QUEUE family, the landing: what deserves a look today. /queue and /moves switch inside via MarketTabs.
  { to: '/queue', label: 'QUEUE', tab: 'QUEUE', glyph: '≋' },
  // RESEARCH family: is there an edge. The board `/board`, the Lab (/lab/*) and the
  // Branches simulator (/branches/*) switch inside via LabTabs.
  { to: '/board', label: 'RESEARCH', tab: 'RSRCH', glyph: '⚗' },
  // TRADE family: what did I do and was I right. /desk, /order and /journal switch inside via TerminalTabs.
  { to: '/desk', label: 'TRADE', tab: 'TRADE', glyph: '◉' },
]

export function isActive(pathname: string, to: string): boolean {
  if (to === '/board') return isResearchPath(pathname)
  if (to === '/desk') return isTerminalPath(pathname)
  if (to === '/queue') return isMarketPath(pathname)
  return pathname === to || pathname.startsWith(`${to}/`)
}

export interface Freshness {
  status: DotStatus
  label: string
  /** Set when the dot is quiet because the server has no database (not a failure). */
  title?: string
}

/** The DATA dot: red only for a real failure; the no-database 503 is a neutral dot with the reason. */
export function freshnessOf(error: string | null, ts: string | null | undefined, now = Date.now()): Freshness {
  if (error) return isDbUnavailable(error) ? { status: 'unknown', label: 'DATA —', title: error } : { status: 'down', label: 'DATA —' }
  if (!ts) return { status: 'unknown', label: 'DATA —' }
  const ageMin = (now - new Date(ts).getTime()) / 60_000
  const status: DotStatus = ageMin < 30 ? 'ok' : ageMin < 120 ? 'degraded' : 'down'
  const label = `DATA ${new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`
  return { status, label }
}

function useFreshness(): Freshness {
  const { data, error } = useApi<{ ts: string | null }[]>('/metrics/summary?ids=hl.total_oi_usd')
  return freshnessOf(error, data?.[0]?.ts)
}

export function AppShell({ children }: { children: ReactNode }) {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const [ask, setAsk] = useState(false)
  const [askMounted, setAskMounted] = useState(false)
  if (ask && !askMounted) setAskMounted(true)
  useEffect(() => {
    const open = () => setAsk(true)
    window.addEventListener('ht:ask', open)
    return () => window.removeEventListener('ht:ask', open)
  }, [])
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
        <Link to="/queue" className="app-wordmark flex items-center gap-1.5 text-sm uppercase font-semibold tracking-wider font-display">
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
          {/* The analyst: a button that toggles a drawer, not a cell. */}
          <Button tier="ghost" aria-expanded={ask} onClick={() => setAsk((v) => !v)} title="ask the analyst">
            ASK
          </Button>
          <ThemeSwitcher />
          <span className="hidden md:flex items-center gap-1.5" title={freshness.title ?? 'last collector run (hl.total_oi_usd)'}>
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
      {askMounted && (
        <Suspense fallback={null}>
          <AskDrawer open={ask} onClose={() => setAsk(false)} />
        </Suspense>
      )}

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
