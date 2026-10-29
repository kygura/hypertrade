import { lazy, Suspense } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router'
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
import { Analyst } from './pages/Analyst'
import { Desk } from './pages/Desk'
import { SkeletonRows } from './components/state'
import { TerminalTabs } from './components/intel/TerminalTabs'
import { MarketTabs } from './components/market/MarketTabs'
import { MetricsStrip } from './components/market/MetricsStrip'
import { LabTabs } from './components/lab/LabTabs'
import { LabDataProvider } from './components/lab/LabData'
import { PageContainer } from './components/PageContainer'

// The drill-in carries the canvas chart library; load it with the route.
const MarketDrill = lazy(() => import('./pages/MarketDrill').then((m) => ({ default: m.MarketDrill })))
// Cycles (ported from hl-cycles): canvas + Recharts charts, loaded with the route.
const Cycles = lazy(() => import('./pages/Cycles').then((m) => ({ default: m.Cycles })))
// Lab (docs/design/README.md §10.9): research view, loaded with its routes.
const Lab = lazy(() => import('./pages/Lab').then((m) => ({ default: m.Lab })))
const LabRule = lazy(() => import('./pages/LabRule').then((m) => ({ default: m.LabRule })))
const LAB_TAB_PATHS = ['/lab/search', '/lab/runs', '/lab/runs/:runId', '/lab/catalogue', '/lab/pulse']
// Terminal family (docs/design/terminal.md §1.1, C1): `/` is the Cockpit, `/terminal`
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
const TERMINAL_PAGES = [
  { path: '/', Page: Cockpit },
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
function MarketLayout({ children }: { children: React.ReactNode }) {
  return (
    <Shell>
      <PageContainer>
        <MarketTabs />
        <MetricsStrip />
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
        {TERMINAL_PAGES.map(({ path, Page }) => (
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
          path="/markets"
          element={
            <MarketLayout>
              <Markets />
            </MarketLayout>
          }
        />
        <Route
          path="/markets/:coin"
          element={
            <MarketLayout>
              <Suspense fallback={<SkeletonRows />}>
                <MarketDrill />
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
              <Analyst />
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
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
