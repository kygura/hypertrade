import { useEffect } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router'
import { AppShell } from './components/AppShell'
import { api } from './lib/api'
import { Login } from './pages/Login'
import { Stub } from './pages/Stub'

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
              <Stub title="OVERVIEW" label="not implemented yet" />
            </Shell>
          }
        />
        <Route
          path="/branches"
          element={
            <Shell>
              <Stub title="BRANCHES" label="not implemented yet" />
            </Shell>
          }
        />
        <Route
          path="/branches/:id"
          element={
            <Shell>
              <Stub title="BRANCH" label="not implemented yet" />
            </Shell>
          }
        />
        <Route
          path="/sectors"
          element={
            <Shell>
              <Stub title="SECTORS" label="not implemented yet" />
            </Shell>
          }
        />
        <Route
          path="/state"
          element={
            <Shell>
              <Stub title="STATE" label="not implemented yet" />
            </Shell>
          }
        />
        <Route
          path="/markets"
          element={
            <Shell>
              <Stub title="MARKETS" label="not implemented yet" />
            </Shell>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
