import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Navigate, useNavigate, useSearchParams } from 'react-router'
import { ConfirmDialog } from '../../components'
import { TerminalTabs } from '../../components/intel/TerminalTabs'
import { api, ApiError } from '../../lib/api'
import type { DeskStatus } from '../../lib/desk'
import { useHlSubscription, type WsAssetCtx } from '../../lib/hlWs'
import { actionFailure, isPlatformOffline, platform } from '../../lib/platformApi'
import { errorMessage, usePoll } from '../../lib/poll'
import type { OpportunityDetail as DetailT } from '../../../shared/platform'
import { filterFeed, isLive, keyAction, stepSelection, STATUS_WORD, type StatusFilter, type TierFilter } from './logic'
import { ActionBar, canApprove, canReject, OpportunityDetail, RejectDialog, TicketDialog } from './Detail'
import { OpportunityFeed } from './Feed'
import { CockpitHeader, HealthStrip, KeysHelp } from './Header'
import { LiqMapPanel, type HistWindow } from './LiqMap'

// Cockpit — DESIGN-terminal § Cockpit (phase 8), route `/`. Container: owns
// the pollers (C8), `?id/status/tier/liqh`, the page keyboard handler (C3)
// and action state (C5). Everything it renders is presentational except
// LiqMapPanel, which polls its own two endpoints.

const STATUS_VALUES: readonly StatusFilter[] = ['live', 'ready', 'decided', 'all']
const LG = '(min-width: 1024px)'

function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [ms])
  return now
}

function useMedia(q: string): boolean {
  const [m, setM] = useState(() => globalThis.matchMedia?.(q).matches ?? true)
  useEffect(() => {
    const mq = globalThis.matchMedia?.(q)
    if (!mq) return
    const on = () => setM(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [q])
  return m
}

export function Cockpit() {
  const [params] = useSearchParams()
  // Old Telegram links (§1.5 now applies to /terminal).
  if (params.get('review') === '1') return <Navigate to="/terminal?review=1" replace />
  return <CockpitPage />
}

type DialogKind = 'approve' | 'reject' | 'kill' | 'help' | null

function CockpitPage() {
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const desktop = useMedia(LG)
  const now = useNow(1000)

  const idParam = params.get('id')
  const status = (STATUS_VALUES as readonly string[]).includes(params.get('status') ?? '') ? (params.get('status') as StatusFilter) : 'live'
  const tierRaw = Number(params.get('tier'))
  const tier: TierFilter = tierRaw === 1 || tierRaw === 2 || tierRaw === 3 ? tierRaw : 'all'
  const liqhRaw = Number(params.get('liqh'))
  const liqh: HistWindow = liqhRaw === 6 || liqhRaw === 72 ? liqhRaw : 24

  const patch = useCallback(
    (next: Record<string, string | null>, push = false) =>
      setParams(
        (p) => {
          const q = new URLSearchParams(p)
          for (const [k, v] of Object.entries(next)) v == null ? q.delete(k) : q.set(k, v)
          return q
        },
        { replace: !push },
      ),
    [setParams],
  )

  // ── pollers (C8) ──
  const feed = usePoll(platform.feed, [], { intervalMs: 15_000, isOffline: isPlatformOffline, offlineFallback: 'platform API unreachable' })
  const health = usePoll(platform.health, [], { intervalMs: 15_000 })
  const desk = usePoll(() => api.get<DeskStatus>('/desk/status'), [], { intervalMs: 30_000 })

  const rows = useMemo(() => feed.data?.opportunities ?? [], [feed.data])
  const { ranked, snoozed } = useMemo(() => filterFeed(rows, status, tier, now), [rows, status, tier, now])
  const [snoozedOpen, setSnoozedOpen] = useState(false)
  const visibleIds = useMemo(() => [...ranked, ...(snoozedOpen ? snoozed : [])].map((r) => r.id), [ranked, snoozed, snoozedOpen])
  const selectedId = idParam ?? ranked[0]?.id ?? null
  const selectedRow = rows.find((r) => r.id === selectedId) ?? null

  const detail = usePoll<DetailT | null>(() => platform.detail(selectedId!), [selectedId], {
    intervalMs: 30_000,
    enabled: selectedId != null,
    isOffline: isPlatformOffline,
    offlineFallback: 'platform API unreachable',
  })
  const d = detail.data?.opportunity.id === selectedId ? detail.data : null
  const coin = d?.opportunity.coin ?? selectedRow?.coin ?? null

  // Live mark from the shared HL WS (activeAssetCtx), with its receive time.
  const [mid, setMid] = useState<{ coin: string; px: number; at: number } | null>(null)
  useHlSubscription<WsAssetCtx>(coin ? { type: 'activeAssetCtx', coin } : null, (m) => {
    const px = Number(m.ctx.markPx)
    if (m.coin === coin && Number.isFinite(px) && px > 0) setMid({ coin: m.coin, px, at: Date.now() })
  })
  const wsMark = mid?.coin === coin ? mid.px : null
  const midAgeSec = mid?.coin === coin ? (now - mid.at) / 1000 : null

  // ── actions (C5) ──
  const [dialog, setDialog] = useState<DialogKind>(null)
  const [snoozeOpen, setSnoozeOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [dialogError, setDialogError] = useState<string | null>(null)
  const [stale, setStale] = useState<string | null>(null)
  const [hint, setHint] = useState<string | null>(null)
  useEffect(() => {
    setHint(null)
    setActionError(null)
    setSnoozeOpen(false)
  }, [selectedId])

  const refresh = useCallback(() => {
    feed.refetch()
    detail.refetch()
  }, [feed, detail])

  const openDialog = (k: DialogKind) => {
    setDialogError(null)
    setStale(null)
    setDialog(k)
  }
  const run = async (fn: () => Promise<unknown>, inDialog: boolean): Promise<boolean> => {
    setBusy(true)
    setActionError(null)
    setDialogError(null)
    try {
      await fn()
      setStale(null)
      return true
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return false
      const f = actionFailure(e)
      if (inDialog && dialog === 'approve' && f.stale) setStale(f.stale)
      else (inDialog ? setDialogError : setActionError)(f.message)
      return false
    } finally {
      setBusy(false)
      refresh()
    }
  }

  // No governor preview (risk or size null) keeps APPROVE disabled, like a block.
  const blockedReason = !d
    ? null
    : !d.risk
      ? 'governor preview unavailable'
      : !d.risk.after.approved
        ? (d.risk.after.reasons[0] ?? 'governor blocks')
        : d.ticket.sizeUsd == null
          ? 'size unavailable'
          : null
  const venue: 'paper' | 'testnet' | null = desk.data ? (desk.data.live ? 'testnet' : 'paper') : null
  const killOn = desk.data?.killSwitch.on ?? false

  const approve = () => d && run(() => platform.approve(d.opportunity.id), true).then((ok) => ok && setDialog(null))
  const reject = (reason: string) => d && run(() => platform.reject(d.opportunity.id, reason), true).then((ok) => ok && setDialog(null))
  const snooze = (minutes: number) => {
    setSnoozeOpen(false)
    if (d) void run(() => platform.snooze(d.opportunity.id, minutes), false)
  }
  const research = () => d && d.opportunity.status !== 'investigating' && void run(() => platform.research(d.opportunity.id), false)
  const toggleKill = async () => {
    setBusy(true)
    setDialogError(null)
    try {
      await api.post('/desk/kill', { on: !killOn })
      setDialog(null)
    } catch (e) {
      setDialogError(errorMessage(e))
    } finally {
      setBusy(false)
      desk.refetch()
    }
  }

  const tryApprove = () => {
    if (!d) return
    if (!canApprove(d.opportunity.status)) return setHint(`approve needs READY — status is ${STATUS_WORD[d.opportunity.status]}`)
    if (blockedReason) return setHint(blockedReason)
    setHint(null)
    openDialog('approve')
  }

  // ── selection ──
  const headingRef = useRef<HTMLHeadingElement>(null)
  const focusRow = useRef(false)
  const select = (id: string, push = !desktop) => patch({ id }, push)
  useEffect(() => {
    if (!focusRow.current) return
    focusRow.current = false
    const tr = document.querySelector<HTMLElement>('[data-feed] tr[aria-selected="true"]')
    tr?.focus()
    tr?.scrollIntoView({ block: 'nearest' })
  }, [selectedId])

  // ── keyboard (C3): one page-level handler ──
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {})
  keyRef.current = (e: KeyboardEvent) => {
    const el = document.activeElement as HTMLElement | null
    const a = keyAction({
      key: e.key,
      ctrlKey: e.ctrlKey,
      metaKey: e.metaKey,
      altKey: e.altKey,
      target: el?.tagName,
      editable: el?.isContentEditable,
      dialogOpen: document.querySelector('[role="dialog"]') != null,
      snoozeOpen,
    })
    if (!a) return
    if (a.type === 'open' && el && ['BUTTON', 'A'].includes(el.tagName)) return // the control's own Enter
    e.preventDefault()
    switch (a.type) {
      case 'next':
      case 'prev': {
        const id = stepSelection(visibleIds, selectedId, a.type === 'next' ? 1 : -1)
        if (id) {
          focusRow.current = true
          select(id, false)
        }
        break
      }
      case 'open':
        if (!selectedId) break
        if (desktop) headingRef.current?.focus()
        else if (el?.tagName !== 'TR') select(selectedId, true) // a row's own Enter already pushed
        break
      case 'approve':
        tryApprove()
        break
      case 'reject':
        if (d && canReject(d.opportunity.status)) openDialog('reject')
        else if (d) setHint(`reject needs READY or APPROVED — status is ${STATUS_WORD[d.opportunity.status]}`)
        break
      case 'snoozeMenu':
        if (d && isLive(d.opportunity.status)) setSnoozeOpen((v) => !v)
        break
      case 'snooze':
        snooze(a.minutes)
        break
      case 'closeMenu':
        setSnoozeOpen(false)
        break
      case 'research':
        research()
        break
      case 'kill':
        if (desk.data) openDialog('kill')
        break
      case 'help':
        openDialog('help')
        break
    }
  }
  useEffect(() => {
    const on = (e: KeyboardEvent) => keyRef.current(e)
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [])

  const liveCount = feed.data ? rows.filter((r) => isLive(r.status)).length : null
  const readyCount = feed.data ? rows.filter((r) => r.status === 'ready').length : null
  const inFeed = selectedId != null && visibleIds.includes(selectedId)

  const liqPanel = coin ? <LiqMapPanel key={coin} coin={coin} wsMark={wsMark} window={liqh} onWindow={(w) => patch({ liqh: w === 24 ? null : String(w) })} now={now} /> : null
  const actionBar = d ? (
    <ActionBar
      status={d.opportunity.status}
      blockedReason={blockedReason}
      venue={venue}
      busy={busy}
      error={actionError}
      hint={hint}
      snoozeOpen={snoozeOpen}
      onApprove={tryApprove}
      onReject={() => openDialog('reject')}
      onSnoozeMenu={() => setSnoozeOpen((v) => !v)}
      onSnooze={snooze}
      onCloseSnooze={() => setSnoozeOpen(false)}
      onResearch={research}
    />
  ) : null

  return (
    <div className="max-w-[1440px] mx-auto px-3 pb-3 md:px-[var(--gutter)] md:pb-[var(--gutter)] flex flex-col">
      <TerminalTabs />
      <CockpitHeader
        venue={venue}
        liveCount={liveCount}
        readyCount={readyCount}
        desk={desk}
        noDb={health.data?.store === 'memory'}
        onKill={() => openDialog('kill')}
        onHelp={() => openDialog('help')}
      />
      <HealthStrip health={health.data} loading={health.loading} offline={health.offline} error={health.error} now={now} />
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-3 mt-3 min-w-0">
        <div className={`lg:col-span-5 xl:col-span-4 min-w-0 ${idParam ? 'hidden lg:block' : ''}`}>
          <OpportunityFeed
            ranked={ranked}
            snoozed={snoozed}
            selectedId={selectedId}
            status={status}
            tier={tier}
            loading={feed.loading && !feed.data}
            offline={feed.data ? null : feed.offline}
            error={feed.data ? null : feed.error}
            scanAgeSec={feed.data?.scanAgeSec ?? null}
            hasRows={rows.length > 0}
            now={now}
            snoozedOpen={snoozedOpen}
            onToggleSnoozed={() => setSnoozedOpen((v) => !v)}
            onSelect={(r) => select(r.id)}
            onFilter={(f) =>
              patch({
                ...(f.status ? { status: f.status === 'live' ? null : f.status } : {}),
                ...(f.tier != null ? { tier: f.tier === 'all' ? null : String(f.tier) } : {}),
              })
            }
            onRetry={feed.refetch}
          />
        </div>
        <div className={`lg:col-span-7 xl:col-span-8 min-w-0 flex-col gap-3 ${idParam ? 'flex' : 'hidden lg:flex'}`}>
          {desktop && liqPanel}
          <OpportunityDetail
            ref={headingRef}
            detail={d}
            notFound={selectedId != null && !detail.loading && detail.data === null && !detail.error && !detail.offline}
            offline={detail.offline}
            error={detail.error}
            hasSelection={selectedId != null}
            inFeed={inFeed}
            mark={wsMark}
            midAgeSec={midAgeSec}
            onRetry={detail.refetch}
            onBack={() => (window.history.length > 1 ? navigate(-1) : patch({ id: null }))}
            onResearch={research}
            liqSlot={desktop ? null : liqPanel}
            actionBar={actionBar}
          />
        </div>
      </div>

      {dialog === 'approve' && d && (
        <TicketDialog detail={d} venue={venue} busy={busy} error={dialogError} stale={stale} onConfirm={() => void approve()} onCancel={() => setDialog(null)} />
      )}
      {dialog === 'reject' && <RejectDialog busy={busy} error={dialogError} onConfirm={(r) => void reject(r)} onCancel={() => setDialog(null)} />}
      {dialog === 'kill' && (
        <ConfirmDialog
          title={killOn ? 'Resume entries' : 'Kill switch'}
          body={killOn ? 'New entries will be allowed again, within the governor limits.' : 'Blocks every new entry, from agents and approvals alike. Exits stay allowed.'}
          confirmLabel={killOn ? 'RESUME' : 'KILL'}
          typedWord={killOn ? undefined : 'KILL'}
          onConfirm={() => void toggleKill()}
          onCancel={() => setDialog(null)}
          error={dialogError}
          busy={busy}
        />
      )}
      {dialog === 'help' && <KeysHelp onClose={() => setDialog(null)} />}
    </div>
  )
}
