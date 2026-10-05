import { lazy, Suspense, useEffect } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router'
import { AppShell } from './components/AppShell'
import { api } from './lib/api'
import { Login } from './pages/Login'
import { Overview } from './pages/Overview'
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

// The drill-in carries the canvas chart library; load it with the route.
const MarketDrill = lazy(() => import('./pages/MarketDrill').then((m) => ({ default: m.MarketDrill })))

// Router — SPEC.md route map. All routes except /login render inside
// AppShell. Auth guard: a session probe on shell mount plus the api.ts
// 401 -> /login redirect on every later call.

function Shell({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    api.get('/auth/me').catch(() => {}) // 401 redirect handled in api.ts
  }, [])
  return <AppShell>{children}</AppShell>
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route
          path="/"
          element={
            <Shell>
              <Overview />
            </Shell>
          }
        />
        <Route
          path="/branches"
          element={
            <Shell>
              <Branches />
            </Shell>
          }
        />
        <Route
          path="/branches/:id"
          element={
            <Shell>
              <BranchDetail />
            </Shell>
          }
        />
        <Route
          path="/sectors"
          element={
            <Shell>
              <Sectors />
            </Shell>
          }
        />
        <Route
          path="/state"
          element={
            <Shell>
              <State />
            </Shell>
          }
        />
        <Route
          path="/markets"
          element={
            <Shell>
              <Markets />
            </Shell>
          }
        />
        <Route
          path="/markets/:coin"
          element={
            <Shell>
              <Suspense fallback={<SkeletonRows />}>
                <MarketDrill />
              </Suspense>
            </Shell>
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
              <Analyst />
            </Shell>
          }
        />
        <Route
          path="/desk"
          element={
            <Shell>
              <Desk />
            </Shell>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
