import { lazy, Suspense, type ComponentType } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useLocation, useParams } from 'react-router'
import { rootRedirect } from './lib/research'
import { AppShell } from './components/AppShell'
import { ErrorBoundary } from './components/ErrorBoundary'
import { Login } from './pages/Login'
import { SkeletonRows } from './components/state'
import { TerminalTabs } from './components/intel/TerminalTabs'
import { MarketTabs } from './components/market/MarketTabs'
import { MetricsStrip } from './components/market/MetricsStrip'
import { LabTabs } from './components/lab/LabTabs'
import { LabDataProvider } from './components/lab/LabData'
import { PageContainer } from './components/PageContainer'

// QUEUE (home) and the coin page: loaded with their routes.
// Every page is its own chunk, so the entry bundle carries the shell only. Once the first page has
// painted and the browser is idle, the other chunks are fetched, so a later navigation does not wait
// for one (skipped when the browser asks to save data).
const pageLoaders: Array<() => Promise<unknown>> = []
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function page<T extends ComponentType<any>>(load: () => Promise<{ default: T }>) {
  pageLoaders.push(load)
  return lazy(load)
}
if (typeof window !== 'undefined') {
  const idle: (cb: () => void) => void = window.requestIdleCallback ?? ((cb) => setTimeout(cb, 2000))
  const warm = () => idle(() => pageLoaders.forEach((load) => void load().catch(() => {})))
  const saveData = (navigator as { connection?: { saveData?: boolean } }).connection?.saveData
  if (!saveData) {
    if (document.readyState === 'complete') warm()
    else window.addEventListener('load', warm, { once: true })
  }
}

const Queue = page(() => import('./pages/queue/Queue').then((m) => ({ default: m.Queue })))
const CoinPage = page(() => import('./pages/coin/CoinPage').then((m) => ({ default: m.CoinPage })))
// The analyst page (also the ASK drawer's parts): its own chunk, loaded with /analyst or the first ASK open.
const Analyst = page(() => import('./pages/Analyst').then((m) => ({ default: m.Analyst })))
// Cycles (ported from hl-cycles): canvas + Recharts charts, loaded with the route.
const Cycles = page(() => import('./pages/Cycles').then((m) => ({ default: m.Cycles })))
// BTC Vector regime screen (ported from hl-cycles): canvas chart, loaded with the route.
const Vector = page(() => import('./pages/Vector').then((m) => ({ default: m.Vector })))
// Lab (docs/design/README.md §10.9): research view, loaded with its routes.
const Lab = page(() => import('./pages/Lab').then((m) => ({ default: m.Lab })))
const LabRule = page(() => import('./pages/LabRule').then((m) => ({ default: m.LabRule })))
const LAB_TAB_PATHS = ['/lab/study', '/lab/search', '/lab/runs', '/lab/runs/:runId', '/lab/catalogue', '/lab/pulse']
// Research board (docs/RESEARCH.md "Board") at `/board`. `/` is no page: Root sends it to the landing
// `/queue`, old Cockpit queries (`/?id=…`) to `/feed`, `/?review=1` to `/terminal?review=1` and an old
// board link (`/?coin=…`) to `/board`.
const Board = page(() => import('./pages/research/Board').then((m) => ({ default: m.Board })))
// Terminal family (docs/design/terminal.md §1.1, C1): `/feed` is the Cockpit, `/terminal`
// the Terminal; each sub-tab is its own route, loaded with it. `/overview`
// redirects to `/markets`.
const Cockpit = page(() => import('./pages/cockpit/Cockpit').then((m) => ({ default: m.Cockpit })))
const Terminal = page(() => import('./pages/terminal/Terminal').then((m) => ({ default: m.Terminal })))
const Journal = page(() => import('./pages/terminal/Journal').then((m) => ({ default: m.Journal })))
const Theses = page(() => import('./pages/terminal/Theses').then((m) => ({ default: m.Theses })))
const Query = page(() => import('./pages/terminal/Query').then((m) => ({ default: m.Query })))
const Order = page(() => import('./pages/terminal/Order').then((m) => ({ default: m.Order })))
const Watch = page(() => import('./pages/terminal/Watch').then((m) => ({ default: m.Watch })))
// `/asset/:coin` is a drill-in of `/terminal` (DESIGN-terminal §15.4), under TerminalTabs.
const Asset = page(() => import('./pages/terminal/Asset').then((m) => ({ default: m.Asset })))
// MOVES (docs/design/README.md §10.13): attribution table; the triage lives in QUEUE, the landing.
const Moves = page(() => import('./pages/moves/Moves').then((m) => ({ default: m.Moves })))
// The older, less-visited pages: out of the entry bundle like the rest.
const Markets = page(() => import('./pages/Markets').then((m) => ({ default: m.Markets })))
const Branches = page(() => import('./pages/Branches').then((m) => ({ default: m.Branches })))
const BranchDetail = page(() => import('./pages/BranchDetail').then((m) => ({ default: m.BranchDetail })))
const Sectors = page(() => import('./pages/Sectors').then((m) => ({ default: m.Sectors })))
const State = page(() => import('./pages/State').then((m) => ({ default: m.State })))
const Strategies = page(() => import('./pages/Strategies').then((m) => ({ default: m.Strategies })))
const StrategyDetail = page(() => import('./pages/StrategyDetail').then((m) => ({ default: m.StrategyDetail })))
const Decisions = page(() => import('./pages/Decisions').then((m) => ({ default: m.Decisions })))
const DecisionDetail = page(() => import('./pages/DecisionDetail').then((m) => ({ default: m.DecisionDetail })))
const Governor = page(() => import('./pages/Governor').then((m) => ({ default: m.Governor })))
const Desk = page(() => import('./pages/Desk').then((m) => ({ default: m.Desk })))
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
      <ErrorBoundary key={pathname}>
        <Suspense fallback={<SkeletonRows />}>{children}</Suspense>
      </ErrorBoundary>
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
      <Suspense fallback={<SkeletonRows />}>{children}</Suspense>
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
      <Suspense fallback={<SkeletonRows />}>{children}</Suspense>
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
      <Suspense fallback={<SkeletonRows />}>{children}</Suspense>
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
        <Route path="/vector" element={<Navigate to="/htf" replace />} />
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
          path="/htf"
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
