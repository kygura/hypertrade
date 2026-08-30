import { BrowserRouter, Navigate, Route, Routes } from 'react-router'
import { AppShell } from './components/AppShell'
import { Login } from './pages/Login'
import { Stub } from './pages/Stub'

// Router — SPEC.md route map. All routes except /login render inside
// AppShell. The auth guard is the api.ts 401 -> /login redirect (SPEC.md:
// "Frontend route guard redirects to /login"): every view that fetches
// protected data enforces it the moment it calls the API; there is no
// separate session-probe endpoint to gate on before that.

function Shell({ children }: { children: React.ReactNode }) {
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
