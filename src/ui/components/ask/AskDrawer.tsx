import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router'
import { OfflineBlock, SkeletonRows } from '..'
import { ModelSelector } from '../analyst/ModelSelector'
import { offlineFrom, useAnalystThread, type Offline, type TurnState } from '../analyst/useAnalystThread'
import { getAnalystModels, getAnalystStatus, type AnalystCatalog, type AnalystChoice, type AnalystStatus } from '../../lib/analyst'
import { queue } from '../../lib/queue'
import type { QueueItem } from '../../../shared/queue'
import { Composer, Turn, loadStoredChoice, resolveChoice, saveChoice } from '../../pages/Analyst'
import { askContextOf, withContext } from './context'

// ASK as a drawer (docs/RESEARCH.md "Nav"): opens over whatever screen the trader is on, already knows the coin (and
// its queue item) in view, shares the /analyst ASK thread, and closes back to the same place. Read-only, like the page.

const noop = () => {}
const INPUT_ID = 'ask-drawer-q'

export interface AskDrawerViewProps {
  onClose: () => void
  coin: string | null
  onDropChip: () => void
  offline: Offline
  onRetry: () => void
  loading: boolean
  catalog: AnalystCatalog | null
  choice: AnalystChoice | null
  onPick: (c: AnalystChoice) => void
  turns: TurnState[]
  busy: boolean
  labelFor: (provider: string) => string
  draft: string
  setDraft: (s: string) => void
  onAsk: (q: string) => void
  onStop: () => void
  ready: boolean
  endRef?: React.Ref<HTMLDivElement>
  panelRef?: React.Ref<HTMLDivElement>
}

export function AskDrawerView(p: AskDrawerViewProps) {
  return (
    <div className="fixed inset-0 z-50" data-ask-drawer>
      <div className="absolute inset-0 bg-black/50" onClick={p.onClose} aria-hidden="true" />
      <div
        ref={p.panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Ask the analyst"
        // Below md: full screen above the fixed tab bar (56px + safe area).
        className="absolute right-0 top-0 bottom-[calc(56px_+_env(safe-area-inset-bottom))] md:bottom-0 w-full md:w-[440px] bg-panel border-l border-border flex flex-col min-h-0"
      >
        <div className="panel-header gap-2">
          <span className="panel-title">ASK</span>
          <span className="flex-1" />
          <Link to="/analyst" onClick={p.onClose} className="text-xs uppercase tracking-wider text-text-secondary hover:text-text-primary">
            OPEN FULL PAGE →
          </Link>
          <button type="button" onClick={p.onClose} aria-label="Close" className="text-text-secondary hover:text-text-primary px-1">
            ✕
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-border-subtle">
          {p.coin && (
            <span className="inline-flex items-center gap-1 h-[22px] px-2 border border-border bg-elevated text-sm text-text-primary" data-context-chip>
              <span className="text-text-secondary">ABOUT</span> {p.coin}
              <button type="button" onClick={p.onDropChip} aria-label={`Drop ${p.coin} context`} className="text-text-secondary hover:text-text-primary ml-1">
                ✕
              </button>
            </span>
          )}
          <span className="flex-1" />
          {/* Offline (e.g. no provider): the block below says it once; the selector would repeat it. */}
          {!p.offline && <ModelSelector catalog={p.catalog} value={p.choice} onChange={p.onPick} />}
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto p-3 flex flex-col gap-5">
          {p.loading && !p.offline && <SkeletonRows rows={3} />}
          {p.offline && <OfflineBlock compact title={p.offline.title} message={p.offline.message} onRetry={p.onRetry} />}
          {!p.offline && !p.loading && p.turns.length === 0 && (
            <span className="text-sm text-text-secondary">
              {p.coin ? `Ask about ${p.coin} or anything on the tape. ` : 'Ask about the tape, sectors, or the engine\'s decisions. '}
              Read-only; it cannot trade.
            </span>
          )}
          {p.turns.map((t) => (
            <Turn key={t.id} t={t} busy={p.busy} onRetry={p.onAsk} labelFor={p.labelFor} onSaved={noop} onFork={noop} />
          ))}
          <div ref={p.endRef} />
        </div>
        <Composer draft={p.draft} setDraft={p.setDraft} busy={p.busy} onAsk={() => p.onAsk(p.draft)} onStop={p.onStop} disabled={!p.ready} mode="ask" embedded id={INPUT_ID} />
      </div>
    </div>
  )
}

function Body({ onClose }: { onClose: () => void }) {
  const { pathname, search } = useLocation()
  const urlCoin = askContextOf(pathname, search)?.coin ?? null
  const [dropped, setDropped] = useState(false)
  const [item, setItem] = useState<QueueItem | null>(null)
  const [status, setStatus] = useState<AnalystStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [offline, setOffline] = useState<Offline>(null)
  const [catalog, setCatalog] = useState<AnalystCatalog | null>(null)
  const [choice, setChoice] = useState<AnalystChoice | null>(null)
  const [draft, setDraft] = useState('')
  const endRef = useRef<HTMLDivElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)

  const { turns, busy, ask: askThread, stop } = useAnalystThread({
    mode: 'ask',
    choice,
    abortOnUnmount: false, // closing the drawer never costs the answer in flight
    onError: (err) => {
      const off = offlineFrom(err)
      if (off) setOffline(off)
    },
  })

  const probe = useCallback(() => {
    setLoading(true)
    getAnalystStatus()
      .then((s) => {
        setStatus(s)
        setOffline(null)
      })
      .catch((err) => setOffline(offlineFrom(err) ?? { title: 'ANALYST UNAVAILABLE', message: err instanceof Error ? err.message : String(err) }))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    probe()
    getAnalystModels()
      .then((cat) => {
        setCatalog(cat)
        const resolved = resolveChoice(cat, loadStoredChoice())
        setChoice(resolved)
        saveChoice(resolved)
      })
      .catch(() => {}) // the server then uses its own default model
  }, [probe])

  // The queue item for the coin in view: one read on open; no item (or a failed read) leaves the coin chip alone.
  useEffect(() => {
    if (!urlCoin) return
    let live = true
    queue
      .get()
      .then((q) => live && setItem(q.items.find((i) => i.coin === urlCoin) ?? null))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [urlCoin])

  const ready = !!status && !offline
  const coin = dropped ? null : urlCoin
  const labelFor = useMemo(() => {
    const m = new Map((catalog?.providers ?? []).map((p) => [p.id, p.label]))
    return (id: string) => m.get(id) ?? id
  }, [catalog])

  // Focus the composer once it is usable; give focus back to where it was on close.
  useEffect(() => {
    if (ready) document.getElementById(INPUT_ID)?.focus()
  }, [ready])
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    return () => prev?.focus?.()
  }, [])

  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'end' })
  }, [turns.length])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      } else if (e.key === 'Tab' && panelRef.current) {
        const f = [...panelRef.current.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')]
        if (f.length === 0) return
        const first = f[0]!
        const last = f[f.length - 1]!
        if (!panelRef.current.contains(document.activeElement)) {
          e.preventDefault()
          first.focus()
        } else if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const onAsk = useCallback(
    (question: string) => {
      const q = question.trim()
      if (!q || busy) return
      setDraft('')
      void askThread(q, withContext(q, coin ? { coin, item: item?.coin === coin ? item : null } : null))
    },
    [askThread, busy, coin, item],
  )

  return (
    <AskDrawerView
      onClose={onClose}
      coin={coin}
      onDropChip={() => setDropped(true)}
      offline={offline}
      onRetry={probe}
      loading={loading && !status}
      catalog={catalog}
      choice={choice}
      onPick={(c) => {
        setChoice(c)
        saveChoice(c)
      }}
      turns={turns}
      busy={busy}
      labelFor={labelFor}
      draft={draft}
      setDraft={setDraft}
      onAsk={onAsk}
      onStop={stop}
      ready={ready}
      endRef={endRef}
      panelRef={panelRef}
    />
  )
}

export function AskDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null
  return <Body onClose={onClose} />
}

