import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import type { BranchConfig } from '../../../shared/types'
import { api } from '../../lib/api'
import { Button, ErrorBlock } from '..'

// SAVE AS BRANCH — DESIGN-chat §3.1. idle → saving → saved (link) | error.
// Renders a fragment so the card's title row lays out the buttons and the
// error block (order-last, full row).
export function SaveBranchButton({
  name,
  config,
  description,
  savedId,
  onSaved,
}: {
  name: string
  config: BranchConfig
  description: string
  savedId?: string
  onSaved: (id: string) => void
}) {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const linkRef = useRef<HTMLAnchorElement | null>(null)
  const justSaved = useRef(false)

  useEffect(() => {
    if (savedId && justSaved.current) linkRef.current?.focus()
  }, [savedId])

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      const b = await api.post<{ id: string }>('/branches', { name, config: { ...config, description } })
      justSaved.current = true
      // Awaited so SAVED only shows once the result is cached; a run failure is
      // ignored (the branch is saved, /branches/:id shows "not simulated yet").
      await api.post(`/branches/${b.id}/run`).catch(() => {})
      onSaved(b.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  if (savedId) {
    return (
      <Link
        ref={linkRef}
        to={`/branches/${savedId}`}
        className="btn inline-flex items-center justify-center flex-1 md:flex-none h-[var(--control-md)] px-2.5 text-[10px] uppercase tracking-wider border border-border text-text-secondary hover:text-text-primary hover:bg-hover"
      >
        SAVED · OPEN ↗
      </Link>
    )
  }
  return (
    <>
      <Button tier="neutral" type="button" disabled={saving} onClick={() => void save()} className="flex-1 md:flex-none">
        <span className={saving ? 'pulse-label' : undefined}>{saving ? 'SAVING…' : 'SAVE AS BRANCH'}</span>
      </Button>
      {error && (
        <div className="order-last basis-full">
          <ErrorBlock message={error} onRetry={() => void save()} />
        </div>
      )}
    </>
  )
}
