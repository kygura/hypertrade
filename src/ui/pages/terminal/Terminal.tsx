import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import type { Brief, Catalyst, FlowFlag, HeatmapWindow, PositionsResponse, ResearchResult, Review } from '../../../shared/intel'
import { CatalystsPanel, upcomingCatalysts } from '../../components/intel/CatalystsPanel'
import { ExposurePanel } from '../../components/intel/ExposurePanel'
import { firingChips, flagWord } from '../../components/intel/flow'
import { FlowPanel, readFlowWindow, writeFlowWindow } from '../../components/intel/FlowPanel'
import { agoWords } from '../../components/intel/format'
import { mergeAlerts, NewsFeedPanel } from '../../components/intel/NewsFeedPanel'
import { PositionsPanel } from '../../components/intel/PositionsPanel'
import { askDisabledReason, chipQuestion, mergeResearch, statusWord } from '../../components/intel/research'
import { RESEARCH_ANCHOR, ResearchPanel } from '../../components/intel/ResearchPanel'
import { useAction } from '../../components/intel/useAction'
import { CATALYSTS_ANCHOR, FLOW_ANCHOR, NEWS_ANCHOR, ReviewStrip } from '../../components/intel/ReviewStrip'
import { TerminalTabs } from '../../components/intel/TerminalTabs'
import { WhatChangedPanel } from '../../components/intel/WhatChangedPanel'
import { ApiError, NetworkError } from '../../lib/api'
import { intel, INTEL_POLL_MS, reviewThrottle, useIntel, type ResearchAskInput } from '../../lib/intel'
import { errorMessage } from '../../lib/poll'

// `/` — TERMINAL (DESIGN-terminal §3): "what changed since I last looked that
// could affect my positions?". Owns the brief POST (§1.5: on a real open only,
// throttled to once per tab per 5 min; `?review=1` and REVIEW NOW bypass the
// throttle) and the shared pollers (§1.4) the panels read: positions 60 s,
// alerts 60 s, catalysts 5 min, heatmap 5 min (+ on window change, §15.2),
// watchlist on mount + after a write. Polling
// pauses while the tab is hidden (usePoll). Nothing but an open or REVIEW NOW
// posts a brief. RESEARCH (§16): the research poller (60 s, 15 s while a row
// is running or a 409 is unresolved), the ask action shared by the box and the
// detector chips (POST + local prepend), and the card highlight.

const WHAT_CHANGED_ANCHOR = 'terminal-what-changed'

/** Held assets by summed notional, desc (ExposurePanel order, §3.8). */
export function heldByNotional(p: PositionsResponse | null): string[] | null {
  if (!p) return null
  const sum = new Map<string, number>()
  for (const x of p.positions) sum.set(x.asset, (sum.get(x.asset) ?? 0) + Math.abs(x.notionalUsd))
  return [...sum.entries()].sort((a, b) => b[1] - a[1]).map(([a]) => a)
}

/** Soonest upcoming catalyst on held ∪ watched (§3.3 NEXT). */
export function nextExposedCatalyst(list: Catalyst[] | null, heldWatched: Set<string>, now = Date.now()): Catalyst | undefined {
  if (!list) return undefined
  return upcomingCatalysts(list, now).find((c) => new Date(c.scheduledAt).getTime() >= now &&(c.exposed.length > 0 || c.assets.some((a) => heldWatched.has(a))))
}

function announcement(b: Brief): string {
  const since = agoWords(b.since)
  if (b.silent || b.items.length === 0) return `nothing cleared the threshold since ${since}`
  return `${b.items.length} ${b.items.length === 1 ? 'thing' : 'things'} changed since ${since}`
}

export function Terminal() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const deeplink = useRef(params.get('review') === '1')
  const [brief, setBrief] = useState<Brief | null>(() => reviewThrottle.lastBrief())
  const [reviewing, setReviewing] = useState(() => deeplink.current || reviewThrottle.shouldPost())
  const [briefError, setBriefError] = useState<string | null>(null)
  const [briefOffline, setBriefOffline] = useState<string | null>(null)
  const [fromTelegram, setFromTelegram] = useState(false)
  const [announce, setAnnounce] = useState('')
  const started = useRef(false)
  const scrolled = useRef(false)

  const post = useCallback(async (via: Review['via']) => {
    setReviewing(true)
    setBriefError(null)
    setBriefOffline(null)
    try {
      const b = await intel.brief(via)
      reviewThrottle.record(b)
      setBrief(b)
      setAnnounce(announcement(b))
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return // redirect in flight
      if (err instanceof NetworkError) setBriefOffline(errorMessage(err, 'api unreachable'))
      else setBriefError(errorMessage(err))
    } finally {
      setReviewing(false)
    }
  }, [])

  // Mount: post once (StrictMode-safe), show the last stored brief meanwhile.
  useEffect(() => {
    if (started.current) return
    started.current = true
    if (deeplink.current) {
      setFromTelegram(true)
      void post('deeplink') // the request is dispatched synchronously; drop the param now
      navigate('/', { replace: true })
    } else if (reviewing) {
      void post('ui')
    }
    if (!reviewThrottle.lastBrief()) {
      intel
        .latestBrief()
        .then((b) => setBrief((cur) => cur ?? b))
        .catch(() => {
          // the POST (or its absence) decides the panel state; a missing latest is not an error
        })
    }
    // mount only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // `/?review=1`: WHAT CHANGED scrolls into view once the brief lands.
  useEffect(() => {
    if (fromTelegram && brief && !reviewing && !scrolled.current) {
      scrolled.current = true
      document.getElementById(WHAT_CHANGED_ANCHOR)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }, [fromTelegram, brief, reviewing])

  const positions = useIntel(intel.positions, [], { intervalMs: INTEL_POLL_MS.positions })
  const watchlist = useIntel(intel.watchlist, [])
  const catalysts = useIntel(() => intel.catalysts(14), [], { intervalMs: INTEL_POLL_MS.catalysts })
  const [flowWindow, setFlowWindow] = useState<HeatmapWindow>(readFlowWindow)
  const heatmap = useIntel(() => intel.heatmap(flowWindow), [flowWindow], { intervalMs: INTEL_POLL_MS.heatmap })
  const since = brief?.since
  const alerts = useIntel(() => intel.alerts(since ? { since } : {}), [since], {
    intervalMs: INTEL_POLL_MS.alerts,
    enabled: !(reviewing && !brief),
  })

  // ── research (§16) ──
  const [localResearch, setLocalResearch] = useState<ResearchResult[]>([])
  const [pending, setPending] = useState<{ question: string; asset: string | null } | null>(null)
  const [conflictAt, setConflictAt] = useState<number | null>(null)
  const [limitDay, setLimitDay] = useState<string | null>(null)
  const [highlightId, setHighlightId] = useState<string | null>(() => /^#research-(.+)$/.exec(globalThis.location?.hash ?? '')?.[1] ?? null)
  const [polledRunning, setPolledRunning] = useState(false)
  const research = useIntel(() => intel.research({ limit: 20 }), [], {
    intervalMs: polledRunning || conflictAt != null ? INTEL_POLL_MS.researchRunning : INTEL_POLL_MS.research,
  })
  const researchItems = useMemo(() => mergeResearch(localResearch, research.data?.items ?? []), [localResearch, research.data])
  useEffect(() => {
    const running = (research.data?.items ?? []).some((r) => r.status === 'running')
    setPolledRunning(running)
    // a 409 clears once a poll after it shows no running row
    if (!running && conflictAt != null && (research.fetchedAt ?? 0) > conflictAt) setConflictAt(null)
  }, [research.data, research.fetchedAt, conflictAt])
  const askAction = useAction((input: ResearchAskInput) => intel.ask(input))
  const askReason = askDisabledReason({
    busy: askAction.busy,
    items: researchItems,
    usedToday: research.data?.usedToday,
    limit: research.data?.limit,
    conflict: conflictAt != null,
    limitDay,
  })
  const runAsk = async (input: ResearchAskInput) => {
    if (askReason) return
    setPending({ question: input.question, asset: input.asset ?? null })
    const r = await askAction.run(input)
    setPending(null)
    if (r) {
      setLocalResearch((cur) => [r, ...cur.filter((x) => x.id !== r.id)])
      setAnnounce(`research ready: ${statusWord(r.status).toLowerCase()}`)
      if (input.flagId) heatmap.refetch() // the chip flips to SEE RESEARCH once the flag joins its researchId
    }
  }
  // useAction keeps the last failure's status; the 409/429 gates key off it.
  useEffect(() => {
    if (askAction.status === 409) setConflictAt(Date.now())
    if (askAction.status === 429) setLimitDay(new Date().toISOString().slice(0, 10))
  }, [askAction.status, askAction.error])
  const scrollToResearch = () => document.getElementById(RESEARCH_ANCHOR)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  const seeResearch = async (id: string, asset: string) => {
    setHighlightId(id)
    if (researchItems.some((r) => r.id === id)) return
    // not among the loaded cards: refetch scoped to the asset, else the asset page has it as an event
    try {
      const scoped = await intel.research({ asset, limit: 20 })
      if (scoped.items.some((r) => r.id === id)) {
        setLocalResearch((cur) => mergeResearch(cur, scoped.items))
        return
      }
    } catch {
      // fall through to the asset page
    }
    navigate(`/asset/${encodeURIComponent(asset)}`)
  }
  const flagText = useMemo(() => {
    const m = new Map((heatmap.data?.flags ?? []).map((f) => [f.id, `${flagWord(f).toLowerCase()} · ${f.asset} ${f.window}`]))
    return (id: string) => m.get(id)
  }, [heatmap.data])
  // `/#terminal-research` (the asset page's SEE ON TERMINAL) lands on the panel once it has data.
  const hashScrolled = useRef(false)
  useEffect(() => {
    if (hashScrolled.current || !research.data || globalThis.location?.hash !== `#${RESEARCH_ANCHOR}`) return
    hashScrolled.current = true
    scrollToResearch()
  }, [research.data])

  const held = useMemo(() => new Set(positions.data?.positions.map((p) => p.asset) ?? []), [positions.data])
  const watched = useMemo(() => new Set(watchlist.data?.items.map((i) => i.asset) ?? []), [watchlist.data])
  const heldWatched = useMemo(() => new Set([...held, ...watched]), [held, watched])
  const exposureAssets = useMemo(() => heldByNotional(positions.data), [positions.data])
  const batched = brief?.alerts ?? []
  const alertsCount = mergeAlerts(alerts.data, batched).length
  const superseded = reviewing && brief != null
  const detectorsCount = heatmap.data ? firingChips(heatmap.data.flags, new Map(heatmap.data.rows.map((r) => [r.asset, r.materiality]))).length : 0

  return (
    <div className="max-w-[1440px] mx-auto px-3 pb-3 md:px-[var(--gutter)] md:pb-[var(--gutter)] flex flex-col" onClickCapture={() => setHighlightId(null)}>
      <TerminalTabs />
      <p className="sr-only" aria-live="polite">
        {announce}
      </p>
      <div className="flex flex-col gap-3 lg:grid lg:grid-cols-12 lg:items-stretch">
        <div className="lg:col-span-12">
          <ReviewStrip
            brief={brief}
            reviewing={reviewing}
            superseded={superseded}
            error={briefError}
            offline={briefOffline}
            sources={positions.data?.sources ?? null}
            alertsCount={alertsCount}
            detectorsCount={detectorsCount}
            nextCatalyst={nextExposedCatalyst(catalysts.data, heldWatched)}
            fromTelegram={fromTelegram}
            onReview={() => void post('ui')}
          />
        </div>
        <div id={WHAT_CHANGED_ANCHOR} className="lg:col-span-7 scroll-mt-[100px] min-w-0">
          <WhatChangedPanel
            brief={brief}
            loading={reviewing}
            superseded={superseded}
            error={briefError}
            offline={briefOffline}
            onRetry={() => void post('ui')}
          />
        </div>
        <div id={NEWS_ANCHOR} className="lg:col-span-5 scroll-mt-[100px] min-w-0">
          <NewsFeedPanel
            state={alerts}
            batched={batched}
            since={since ?? null}
            ingest={brief?.ingest}
            pushMateriality={brief?.threshold?.pushMateriality}
          />
        </div>
        <div id={FLOW_ANCHOR} className="lg:col-span-12 scroll-mt-[100px] min-w-0">
          <FlowPanel
            state={heatmap}
            window={flowWindow}
            onWindow={(w) => {
              setFlowWindow(w)
              writeFlowWindow(w)
            }}
            research={{
              askDisabledReason: askReason,
              onResearch: (f: FlowFlag) => {
                scrollToResearch()
                void runAsk({ question: chipQuestion(f), asset: f.asset, flagId: f.id })
              },
              onSeeResearch: (id, asset) => void seeResearch(id, asset),
            }}
          />
        </div>
        <div id={RESEARCH_ANCHOR} className="lg:col-span-12 scroll-mt-[100px] min-w-0">
          <ResearchPanel
            state={research}
            ask={askAction}
            local={localResearch}
            pending={pending}
            heldWatched={heldWatched}
            highlightId={highlightId}
            disabledReason={askReason}
            flagText={flagText}
            onAsk={(input) => void runAsk(input)}
          />
        </div>
        <div className="lg:col-span-8 min-w-0">
          <PositionsPanel positions={positions} watchlist={watchlist} />
        </div>
        <div id={CATALYSTS_ANCHOR} className="lg:col-span-4 scroll-mt-[100px] min-w-0">
          <CatalystsPanel state={catalysts} held={held} watched={watched} />
        </div>
        <div className="lg:col-span-12 min-w-0">
          <ExposurePanel assets={exposureAssets} />
        </div>
      </div>
    </div>
  )
}
