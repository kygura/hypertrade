import { lazy, Suspense } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useLocation, useParams } from 'react-router'
import { rootRedirect } from './lib/research'
import { AppShell } from './components/AppShell'
import { ErrorBoundary } from './components/ErrorBoundary'
import { Login } from './pages/Login'
import { Markets } from './pages/Markets'
import { Branches } from './pages/Branches'
import { BranchDetail } from './pages/BranchDetail'
import { Sectors } from './pages/Sectors'
import { State } from './pages/State'
import { Strategies } from './pages/Strategies'
import { StrategyDetail } from './pages/StrategyDetail'
import { Decisions } from './pages/Decisions'
import { DecisionDetail } from './pages/DecisionDetail'
import { Governor } from './pages/Governor'
import { Desk } from './pages/Desk'
import { SkeletonRows } from './components/state'
import { TerminalTabs } from './components/intel/TerminalTabs'
import { MarketTabs } from './components/market/MarketTabs'
import { MetricsStrip } from './components/market/MetricsStrip'
import { LabTabs } from './components/lab/LabTabs'
import { LabDataProvider } from './components/lab/LabData'
import { PageContainer } from './components/PageContainer'

// QUEUE (home) and the coin page: loaded with their routes.
const Queue = lazy(() => import('./pages/queue/Queue').then((m) => ({ default: m.Queue })))
const CoinPage = lazy(() => import('./pages/coin/CoinPage').then((m) => ({ default: m.CoinPage })))
// The analyst page (also the ASK drawer's parts): its own chunk, loaded with /analyst or the first ASK open.
const Analyst = lazy(() => import('./pages/Analyst').then((m) => ({ default: m.Analyst })))
// Cycles (ported from hl-cycles): canvas + Recharts charts, loaded with the route.
const Cycles = lazy(() => import('./pages/Cycles').then((m) => ({ default: m.Cycles })))
// BTC Vector regime screen (ported from hl-cycles): canvas chart, loaded with the route.
const Vector = lazy(() => import('./pages/Vector').then((m) => ({ default: m.Vector })))
// Lab (docs/design/README.md §10.9): research view, loaded with its routes.
const Lab = lazy(() => import('./pages/Lab').then((m) => ({ default: m.Lab })))
const LabRule = lazy(() => import('./pages/LabRule').then((m) => ({ default: m.LabRule })))
const LAB_TAB_PATHS = ['/lab/study', '/lab/search', '/lab/runs', '/lab/runs/:runId', '/lab/catalogue', '/lab/pulse']
// Research board (docs/RESEARCH.md "Board") at `/board`. `/` is no page: Root sends it to the landing
// `/queue`, old Cockpit queries (`/?id=…`) to `/feed`, `/?review=1` to `/terminal?review=1` and an old
// board link (`/?coin=…`) to `/board`.
const Board = lazy(() => import('./pages/research/Board').then((m) => ({ default: m.Board })))
// Terminal family (docs/design/terminal.md §1.1, C1): `/feed` is the Cockpit, `/terminal`
// the Terminal; each sub-tab is its own route, loaded with it. `/overview`
// redirects to `/markets`.
const Cockpit = lazy(() => import('./pages/cockpit/Cockpit').then((m) => ({ default: m.Cockpit })))
const Terminal = lazy(() => import('./pages/terminal/Terminal').then((m) => ({ default: m.Terminal })))
const Journal = lazy(() => import('./pages/terminal/Journal').then((m) => ({ default: m.Journal })))
const Theses = lazy(() => import('./pages/terminal/Theses').then((m) => ({ default: m.Theses })))
const Query = lazy(() => import('./pages/terminal/Query').then((m) => ({ default: m.Query })))
const Order = lazy(() => import('./pages/terminal/Order').then((m) => ({ default: m.Order })))
const Watch = lazy(() => import('./pages/terminal/Watch').then((m) => ({ default: m.Watch })))
// `/asset/:coin` is a drill-in of `/terminal` (DESIGN-terminal §15.4), under TerminalTabs.
const Asset = lazy(() => import('./pages/terminal/Asset').then((m) => ({ default: m.Asset })))
// MOVES (docs/design/README.md §10.13): attribution table; the triage lives in QUEUE, the landing.
const Moves = lazy(() => import('./pages/moves/Moves').then((m) => ({ default: m.Moves })))
const TOP_PAGES = [
  { path: '/board', Page: Board },
  { path: '/feed', Page: Cockpit },
  { path: '/terminal', Page: Terminal },
  { path: '/journal', Page: Journal },
  { path: '/theses', Page: Theses },
  { path: '/query', Page: Query },
  { path: '/order', Page: Order },
  { path: '/watch', Page: Watch },
  { path: '/asset/:coin', Page: Asset },
]

// Router — docs/SPEC.md route map. All routes except /login render inside
// AppShell. Auth guard: AppShell's /auth/me probe on mount plus the api.ts
// 401 -> /login redirect on every later call.

// `/markets/:coin` moved onto the coin page (PerpHeader, chart and funding live there).
function CoinRedirect() {
  const { coin = '' } = useParams()
  const tf = new URLSearchParams(useLocation().search).get('tf')
  return <Navigate to={`/coin/${encodeURIComponent(coin)}?chart=price${tf ? `&tf=${encodeURIComponent(tf)}` : ''}`} replace />
}

function Root() {
  return <Navigate to={rootRedirect(useLocation().search)} replace />
}

function Shell({ children }: { children: React.ReactNode }) {
  const { pathname } = useLocation()
  return (
    <AppShell>
      <ErrorBoundary key={pathname}>{children}</ErrorBoundary>
    </AppShell>
  )
}

// TRADE family page that does not render its own tab row (Desk).
function TradeLayout({ children }: { children: React.ReactNode }) {
  return (
    <Shell>
      <PageContainer>
        <TerminalTabs />
      </PageContainer>
      {children}
    </Shell>
  )
}

// MARKET family page: MarketTabs + the MetricsStrip above the page.
// `metrics={false}`: QUEUE and the coin page carry nothing above the content (the strip is terminal furniture).
export function MarketLayout({ children, metrics = true }: { children: React.ReactNode; metrics?: boolean }) {
  return (
    <Shell>
      <PageContainer>
        <MarketTabs />
        {metrics && <MetricsStrip />}
      </PageContainer>
      {children}
    </Shell>
  )
}

// RESEARCH family page outside /lab (Branches): the Lab tab row above it.
function ResearchLayout({ children }: { children: React.ReactNode }) {
  return (
    <Shell>
      <LabDataProvider>
        <PageContainer>
          <LabTabs />
        </PageContainer>
      </LabDataProvider>
      {children}
    </Shell>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/" element={<Root />} />
        {TOP_PAGES.map(({ path, Page }) => (
          <Route
            key={path}
            path={path}
            element={
              <Shell>
                <Suspense fallback={<SkeletonRows />}>
                  <Page />
                </Suspense>
              </Shell>
            }
          />
        ))}
        <Route path="/overview" element={<Navigate to="/markets" replace />} />
        <Route
          path="/branches"
          element={
            <ResearchLayout>
              <Branches />
            </ResearchLayout>
          }
        />
        <Route
          path="/branches/:id"
          element={
            <ResearchLayout>
              <BranchDetail />
            </ResearchLayout>
          }
        />
        <Route
          path="/sectors"
          element={
            <MarketLayout>
              <Sectors />
            </MarketLayout>
          }
        />
        <Route
          path="/state"
          element={
            <MarketLayout>
              <State />
            </MarketLayout>
          }
        />
        <Route
          path="/moves"
          element={
            <MarketLayout>
              <Suspense fallback={<SkeletonRows />}>
                <Moves />
              </Suspense>
            </MarketLayout>
          }
        />
        <Route
          path="/markets"
          element={
            <MarketLayout>
              <Markets />
            </MarketLayout>
          }
        />
        <Route path="/markets/:coin" element={<CoinRedirect />} />
        <Route
          path="/queue"
          element={
            <MarketLayout metrics={false}>
              <Suspense fallback={<SkeletonRows />}>
                <Queue />
              </Suspense>
            </MarketLayout>
          }
        />
        <Route
          path="/coin/:coin"
          element={
            <MarketLayout metrics={false}>
              <Suspense fallback={<SkeletonRows />}>
                <CoinPage />
              </Suspense>
            </MarketLayout>
          }
        />
        {['/cycles', '/cycles/:coin'].map((path) => (
          <Route
            key={path}
            path={path}
            element={
              <MarketLayout>
                <Suspense fallback={<SkeletonRows />}>
                  <Cycles />
                </Suspense>
              </MarketLayout>
            }
          />
        ))}
        <Route
          path="/vector"
          element={
            <MarketLayout>
              <Suspense fallback={<SkeletonRows />}>
                <Vector />
              </Suspense>
            </MarketLayout>
          }
        />
        <Route
          path="/strategies"
          element={
            <Shell>
              <Strategies />
            </Shell>
          }
        />
        <Route
          path="/strategies/:id"
          element={
            <Shell>
              <StrategyDetail />
            </Shell>
          }
        />
        <Route
          path="/decisions"
          element={
            <Shell>
              <Decisions />
            </Shell>
          }
        />
        <Route
          path="/decisions/:id"
          element={
            <Shell>
              <DecisionDetail />
            </Shell>
          }
        />
        <Route
          path="/governor"
          element={
            <Shell>
              <Governor />
            </Shell>
          }
        />
        <Route
          path="/analyst"
          element={
            <Shell>
              <Suspense fallback={<SkeletonRows />}>
                <Analyst />
              </Suspense>
            </Shell>
          }
        />
        <Route
          path="/desk"
          element={
            <TradeLayout>
              <Desk />
            </TradeLayout>
          }
        />
        <Route path="/lab" element={<Navigate to="/lab/search" replace />} />
        {LAB_TAB_PATHS.map((path) => (
          <Route
            key={path}
            path={path}
            element={
              <Shell>
                <Suspense fallback={<SkeletonRows />}>
                  <Lab />
                </Suspense>
              </Shell>
            }
          />
        ))}
        <Route
          path="/lab/rules/:id"
          element={
            <Shell>
              <Suspense fallback={<SkeletonRows />}>
                <LabRule />
              </Suspense>
            </Shell>
          }
        />
        <Route path="*" element={<Navigate to="/queue" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
