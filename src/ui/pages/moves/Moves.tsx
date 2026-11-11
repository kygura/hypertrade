import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { ApiError } from '../../lib/api'
import { useMedia, useNow, useQueryPatch } from '../../lib/hooks'
import { moves } from '../../lib/moves'
import { usePoll } from '../../lib/poll'
import { research } from '../../lib/research'
import { stepSelection } from '../cockpit/logic'
import { MovesView } from './MovesView'
import { filterSector, investigateFailure, moveKey, parseCoin, parseSort, parseWindow, sortRows } from './logic'

// MOVES — the MARKET cell's first tab, route `/moves` (docs/design/README.md § MOVES). Container: owns the
// pollers (moves, triage and detail every 60 s, record stats every 5 min; all pause while the tab is hidden),
// `?window/coin/sector/sort`, the page keyboard handler (j/k/Enter) and the two actions. MovesView is
// presentational. Nothing here approves, kills or places an order.

const LG = '(min-width: 1024px)'
const POLL_MS = 60_000
/** A first run is asked again this often while it loads candles. */
const PENDING_POLL_MS = 15_000

export function Moves() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const patch = useQueryPatch()
  const desktop = useMedia(LG)
  const now = useNow(30_000)

  const win = parseWindow(params.get('window'))
  const sort = parseSort(params.get('sort'))
  const sector = params.get('sector') || null
  const coinParam = parseCoin(params.get('coin'))

  // Phone: the detail shows after a tap (?coin pushed as a history entry); nothing polls behind the hidden pane.
  const showDetail = desktop || coinParam != null
  const showList = desktop || coinParam == null

  // Re-poll cadence follows the state: a pending first run is asked more often.
  const [fast, setFast] = useState(false)
  const feed = usePoll(() => moves.list(win), [win], { intervalMs: fast ? PENDING_POLL_MS : POLL_MS, enabled: showList })
  useEffect(() => setFast(feed.data?.state === 'pending'), [feed.data])
  const triage = usePoll(moves.triage, [], { intervalMs: POLL_MS, enabled: showList })

  const rows = useMemo(() => sortRows(filterSector(feed.data?.rows ?? [], sector), sort), [feed.data, sector, sort])
  const selected = coinParam ?? (desktop ? (rows[0]?.coin ?? null) : null)

  const detail = usePoll(() => moves.detail(selected!, win), [selected, win], { intervalMs: POLL_MS, enabled: selected != null && showDetail })
  const stats = usePoll(moves.stats, [], { intervalMs: 300_000, enabled: showDetail })
  const defs = usePoll(research.definitions, [], { intervalMs: null, enabled: showDetail })

  // ── actions ──
  const [busy, setBusy] = useState<string[]>([])
  const [actionError, setActionError] = useState<{ coin: string; message: string } | null>(null)
  const dismiss = useCallback(
    async (id: string) => {
      try {
        await moves.dismiss(id)
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return
        setActionError({ coin: triage.data?.items.find((i) => i.id === id)?.coin ?? '', message: e instanceof Error ? e.message : 'dismiss failed' })
      } finally {
        triage.refetch()
      }
    },
    [triage],
  )
  const investigate = useCallback(
    async (coin: string) => {
      setActionError(null)
      setBusy((b) => (b.includes(coin) ? b : [...b, coin]))
      try {
        await moves.investigate(coin)
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return
        setActionError({ coin, message: investigateFailure(e instanceof ApiError ? e.status : undefined, e instanceof Error ? e.message : '') })
      } finally {
        setBusy((b) => b.filter((c) => c !== coin))
        triage.refetch()
        detail.refetch()
      }
    },
    [triage, detail],
  )

  // ── selection ──
  const select = useCallback((coin: string, push = !desktop) => patch({ coin }, push), [patch, desktop])
  const back = () => (coinParam ? navigate(-1) : patch({ coin: null }))
  const focusRow = useRef(false)
  useEffect(() => {
    if (!focusRow.current) return
    focusRow.current = false
    const tr = document.querySelector<HTMLElement>('[data-moves] tr[aria-selected="true"]')
    tr?.focus()
    tr?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  // ── keyboard: j/k move, Enter opens (phone: pushes ?coin) ──
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
    if (!a || !showList) return
    if (a === 'open' && el && ['BUTTON', 'A'].includes(el.tagName)) return // the control's own Enter
    e.preventDefault()
    const ids = rows.map((r) => r.coin)
    if (a === 'open') {
      if (selected && !desktop && el?.tagName !== 'TR') select(selected, true) // a row's own Enter already pushed
      return
    }
    const next = stepSelection(ids, selected, a === 'next' ? 1 : -1)
    if (next) {
      focusRow.current = true
      select(next, false)
    }
  }
  useEffect(() => {
    const on = (e: KeyboardEvent) => keyRef.current(e)
    globalThis.addEventListener('keydown', on)
    return () => globalThis.removeEventListener('keydown', on)
  }, [])

  return (
    <MovesView
      window={win}
      onWindow={(w) => patch({ window: w === '24h' ? null : w })}
      moves={feed}
      triage={triage}
      detail={detail}
      stats={stats.data}
      defs={defs.data}
      rows={rows}
      sort={sort}
      onSort={(k) => patch({ sort: k === 'z' ? null : k })}
      sector={sector}
      onSector={(id) => patch({ sector: id })}
      selected={selected}
      onSelect={(c) => select(c)}
      onBack={back}
      showList={showList}
      showDetail={showDetail}
      now={now}
      onDismiss={dismiss}
      onInvestigate={investigate}
      busy={busy}
      actionError={actionError}
    />
  )
}
