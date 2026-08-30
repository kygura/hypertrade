import { useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { Button } from '../components/Button'
import { ErrorBlock } from '../components/state'
import { api, ApiError, consumeRedirectTarget } from '../lib/api'

// /login — DESIGN.md §10.1. Renders without the shell. Only idle/in-flight/
// error states — no skeletons here.

export function Login() {
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const navigate = useNavigate()

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      await api.post('/auth/login', { password })
      navigate(consumeRedirectTarget('/'), { replace: true })
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'request failed')
      inputRef.current?.focus()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex items-center justify-center px-4" style={{ minHeight: '100dvh' }}>
      <form onSubmit={submit} className="panel w-full max-w-[320px]">
        <div className="p-4 flex flex-col gap-3">
          <div className="flex items-center gap-1.5 text-[16px] uppercase font-semibold tracking-wider">
            HYPERTRADE
            <span className="inline-block w-1.5 h-1.5 bg-red-accent" />
          </div>

          <label className="flex flex-col gap-1">
            <span className="label">PASSWORD</span>
            <input
              ref={inputRef}
              type="password"
              autoFocus
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full"
            />
          </label>

          {error && <ErrorBlock message={error} />}

          <Button tier="neutral" type="submit" disabled={submitting} className="w-full" style={{ height: 'var(--control-lg)' }}>
            <span className={submitting ? 'pulse-label' : undefined}>{submitting ? 'ENTERING…' : 'ENTER'}</span>
          </Button>
        </div>
      </form>
    </div>
  )
}
