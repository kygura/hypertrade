import { useEffect, useState } from 'react'
import { Button } from '../Button'
import { api, ApiError } from '../../lib/api'

// TriggerRoutineButton — DESIGN.md §7 "trigger-routine special case" (Level
// 1 with consequence copy) + §10.6. Neutral tier, --control-lg. 60s disable
// + "REQUESTED HH:MM" after a successful POST. An unset ROUTINE_WEBHOOK_URL
// is server-reported configuration state, not an error — rendered as info.

const COOLDOWN_MS = 60_000

interface TriggerResponse {
  triggered: boolean
  last_trigger: { requested_at: string; ok: boolean; error?: string }
}

export function TriggerRoutineButton() {
  const [pending, setPending] = useState(false)
  const [cooldownUntil, setCooldownUntil] = useState<number | null>(null)
  const [requestedAt, setRequestedAt] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ kind: 'info' | 'error'; message: string } | null>(null)

  useEffect(() => {
    if (cooldownUntil == null) return
    const t = setTimeout(() => setCooldownUntil(null), Math.max(cooldownUntil - Date.now(), 0))
    return () => clearTimeout(t)
  }, [cooldownUntil])

  const trigger = async () => {
    setPending(true)
    setNotice(null)
    try {
      const res = await api.post<TriggerResponse>('/routines/trigger')
      if (res.last_trigger.ok) {
        setRequestedAt(res.last_trigger.requested_at)
        setCooldownUntil(Date.now() + COOLDOWN_MS)
      } else if (res.last_trigger.error === 'ROUTINE_WEBHOOK_URL not set') {
        setNotice({ kind: 'info', message: res.last_trigger.error })
      } else {
        setNotice({ kind: 'error', message: res.last_trigger.error ?? 'trigger failed' })
      }
    } catch (err) {
      setNotice({ kind: 'error', message: err instanceof ApiError ? err.message : 'trigger failed' })
    } finally {
      setPending(false)
    }
  }

  const cooling = cooldownUntil != null
  const label = pending ? 'REQUESTING…' : cooling && requestedAt ? `REQUESTED ${requestedAt.slice(11, 16)}` : 'TRIGGER ROUTINE'

  return (
    <div className="flex flex-col items-end gap-1">
      <Button tier="neutral" style={{ height: 'var(--control-lg)' }} disabled={pending || cooling} onClick={trigger}>
        {label}
      </Button>
      <span className="text-[10px] text-text-secondary">requests a cloud routine run — results land on the next deploy</span>
      {notice && (
        <span className={`text-[10px] ${notice.kind === 'info' ? 'text-info' : 'text-red-text'}`}>{notice.message}</span>
      )}
    </div>
  )
}
