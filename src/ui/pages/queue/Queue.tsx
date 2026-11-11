import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { ApiError } from '../../lib/api'
import { useMedia, useNow, useQueryPatch } from '../../lib/hooks'
import { usePoll } from '../../lib/poll'
import { queue, QUEUE_POLL_MS } from '../../lib/queue'
import { stepSelection } from '../cockpit/logic'
import { moveKey } from '../moves/logic'
import { QueueView } from './QueueView'
import { defaultSelection, splitItems } from './logic'

// QUEUE — the home screen, route `/queue` (docs/SPEC.md § Queue, PLAN2 §2.1/§2.2). Container: polls /api/queue
// every QUEUE_POLL_MS (paused while the tab is hidden), keeps the desktop selection in `?coin=` (replace), the
// keyboard (j/k move, Enter opens `/coin/:coin`; off while a dialog such as the ASK drawer is open) and DISMISS.
// Phone: a tap opens the coin page (push, so back returns to the list). QueueView is presentational.

const LG = '(min-width: 1024px)'
const coinPath = (coin: string) => `/coin/${encodeURIComponent(coin)}`

export function Queue() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const patch = useQueryPatch()
  const desktop = useMedia(LG)
  const now = useNow(30_000)

  const feed = usePoll(queue.get, [], { intervalMs: QUEUE_POLL_MS })
  const items = feed.data?.items ?? []

  const param = params.get('coin')
  // Phone: no default selection (a tap opens the coin page); an explicit ?coin= still highlights its row.
  const selected = desktop || param ? defaultSelection(items, param) : null
  const { handled } = splitItems(items)
  const [handledOpen, setHandledOpen] = useState(false)
  const showHandled = handledOpen || handled.some((i) => i.coin === selected)

  // ── DISMISS ──
  const [pending, setPending] = useState<string[]>([])
  const [error, setError] = useState<{ id: string; message: string } | null>(null)
  const dismiss = useCallback(
    async (id: string) => {
      setPending((p) => [...p, id])
      setError(null)
      try {
        await queue.dismiss(id)
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 401)) setError({ id, message: e instanceof Error ? e.message : 'dismiss failed' })
      } finally {
        setPending((p) => p.filter((x) => x !== id))
        feed.refetch()
      }
    },
    [feed],
  )

  // ── selection: desktop shows the pane (?coin replace); phone opens the coin page ──
  const open = useCallback((coin: string) => navigate(coinPath(coin)), [navigate])
  const onRow = useCallback((coin: string) => (desktop ? patch({ coin }, false) : open(coin)), [desktop, patch, open])
  const focusRow = useRef(false)
  useEffect(() => {
    if (!focusRow.current) return
    focusRow.current = false
    const el = selected ? document.querySelector<HTMLElement>(`[data-queue] li[data-coin="${CSS.escape(selected)}"] [data-row]`) : null
    el?.focus()
    el?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  // ── keyboard: j/k move, Enter opens the coin page ──
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {})
  keyRef.current = (e) => {
    const el = document.activeElement as HTMLElement | null
    const a = moveKey({
      key: e.key,
      ctrlKey: e.ctrlKey,
      metaKey: e.metaKey,
      altKey: e.altKey,
      target: el?.tagName,
      editable: el?.isContentEditable,
      dialogOpen: document.querySelector('[role="dialog"]') != null,
    })
    if (!a) return
    if (a === 'open') {
      if (el && el.tagName === 'A') return // a link's own Enter
      if (el && el.tagName === 'BUTTON' && !el.hasAttribute('data-row')) return // DISMISS and other controls
      if (!selected) return
      e.preventDefault()
      open(selected)
      return
    }
    const visible = splitItems(items)
    const ids = [...visible.open, ...(showHandled ? visible.handled : [])].map((i) => i.coin)
    const next = stepSelection(ids, selected, a === 'next' ? 1 : -1)
    if (!next) return
    e.preventDefault()
    focusRow.current = true
    patch({ coin: next }, false)
  }
  useEffect(() => {
    const on = (e: KeyboardEvent) => keyRef.current(e)
    globalThis.addEventListener('keydown', on)
    return () => globalThis.removeEventListener('keydown', on)
  }, [])

  return (
    <QueueView
      queue={feed}
      selected={selected}
      onRow={onRow}
      onDismiss={dismiss}
      pending={pending}
      error={error}
      handledOpen={showHandled}
      onHandled={setHandledOpen}
      pane={desktop}
      now={now}
    />
  )
}
