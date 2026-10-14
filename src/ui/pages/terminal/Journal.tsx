import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import { Panel, PanelHeader, Button } from '../../components'
import { EmptyBlock, ErrorBlock, OfflineBlock, SkeletonRows } from '../../components/state'
import { TerminalTabs } from '../../components/intel/TerminalTabs'
import { JournalBar, type JournalDays } from '../../components/intel/JournalBar'
import { ReportCard } from '../../components/intel/ReportCard'
import { TagStatsTable } from '../../components/intel/TagStatsTable'
import { TradeDetail } from '../../components/intel/TradeDetail'
import { isDesktop } from '../../components/intel/format'
import { TradesTable, matchesTag, tradeAnchorId, UNTAGGED_TAG } from '../../components/intel/TradesTable'
import { useAction } from '../../components/intel/useAction'
import { intel, useIntel } from '../../lib/intel'
import type { JournalResponse, TradeNote } from '../../../shared/intel'

// `/journal` — what my own trades say (DESIGN-terminal §4). `?trade=<id>`
// selects a trade, `?tag=<tag>` filters; both written with replace. Loads on
// mount + after a write (§1.4). Mobile order: bar → report → by tag → trades
// → trade (the detail scrolls into view once when a row is picked).

const DAYS_KEY = 'ht_journal_days'

function readDays(): JournalDays {
  try {
    const v = Number(globalThis.localStorage?.getItem(DAYS_KEY))
    return v === 7 || v === 30 || v === 90 ? v : 30
  } catch {
    return 30
  }
}

function writeDays(d: JournalDays): void {
  try {
    globalThis.localStorage?.setItem(DAYS_KEY, String(d))
  } catch {
    // storage unavailable: the window just isn't remembered
  }
}

export function Journal() {
  const [params, setParams] = useSearchParams()
  const selectedId = params.get('trade')
  const tagFilter = params.get('tag')
  const [days, setDaysState] = useState<JournalDays>(readDays)
  const journal = useIntel(() => intel.journal(days), [days])
  const report = useIntel(() => intel.latestReport(), [])
  const [tagNote, setTagNote] = useState<string | null>(null)
  const [tagError, setTagError] = useState<string | null>(null)
  const tag = useAction((d: number) => intel.tagUntagged(d))
  const generate = useAction(() => intel.generateReport())
  const detailRef = useRef<HTMLDivElement>(null)
  const pendingScroll = useRef<string | null>(null)

  const trades = journal.data?.trades ?? []
  const stats = journal.data?.stats ?? []
  const untagged = trades.filter((t) => t.tag == null).length
  const selected = selectedId ? (trades.find((t) => t.id === selectedId) ?? null) : null

  const setDays = (d: JournalDays) => {
    setDaysState(d)
    writeDays(d)
  }

  const patchParams = (patch: Record<string, string | null>) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        for (const [k, v] of Object.entries(patch)) v ? next.set(k, v) : next.delete(k)
        return next
      },
      { replace: true },
    )

  // Scroll to a row picked from the report once it is rendered (after a window change refetch too).
  useEffect(() => {
    const id = pendingScroll.current
    if (!id) return
    const el = document.getElementById(tradeAnchorId(id))
    if (el) {
      pendingScroll.current = null
      el.scrollIntoView({ block: 'center' })
    }
  }, [journal.data, selectedId, tagFilter])

  const onSelectRow = (id: string) => {
    patchParams({ trade: id })
    if (!isDesktop()) requestAnimationFrame(() => detailRef.current?.scrollIntoView({ block: 'start' }))
  }

  const onPickTrade = (id: string) => {
    const known = trades.find((t) => t.id === id)
    if (!known && days !== 90) setDays(90)
    patchParams({ trade: id, tag: known && !matchesTag(known, tagFilter) ? null : known ? tagFilter : null })
    pendingScroll.current = id
  }

  const onTagRow = (t: string) => {
    patchParams({ tag: t })
    requestAnimationFrame(() => document.getElementById('journal-trades')?.scrollIntoView({ block: 'start' }))
  }

  const onTag = async () => {
    setTagNote(null)
    setTagError(null)
    const r = await tag.run(days)
    if (r) {
      setTagNote(`tagged ${r.tagged}${r.failed ? ` · ${r.failed} failed` : ''}`)
      if (r.error) setTagError(r.error)
    }
    journal.refetch()
  }

  const onGenerate = async () => {
    const r = await generate.run()
    if (r) report.setData(r)
  }

  const onNoteSaved = (n: TradeNote) => {
    const data = journal.data
    if (!data) return
    const next: JournalResponse = {
      ...data,
      trades: data.trades.map((t) => (t.id === n.tradeId ? { ...t, note: n.note, tag: n.tag, noteSummary: n.summary } : t)),
    }
    journal.setData(next)
  }

  // ── trades panel body (DESIGN-terminal §10 "Journal trades") ──
  let tradesBody
  if (journal.loading && !journal.data) tradesBody = <SkeletonRows rows={4} />
  else if (journal.offline && !journal.data) tradesBody = <OfflineBlock onRetry={journal.refetch} />
  else if (journal.error && !journal.data) tradesBody = <ErrorBlock message={journal.error} onRetry={journal.refetch} />
  else if (trades.length === 0)
    tradesBody = <EmptyBlock label={`no closed trades in ${days} days`} />
  else tradesBody = <TradesTable trades={trades} selectedId={selectedId} tagFilter={tagFilter} onSelect={onSelectRow} />

  // ── tag stats body ──
  let statsBody
  if (journal.loading && !journal.data) statsBody = <SkeletonRows />
  else if (journal.offline && !journal.data) statsBody = <OfflineBlock onRetry={journal.refetch} />
  else if (journal.error && !journal.data) statsBody = <ErrorBlock message={journal.error} onRetry={journal.refetch} />
  else if (stats.every((s) => s.tag === UNTAGGED_TAG))
    statsBody = (
      <EmptyBlock
        label="no tagged trades — TAG UNTAGGED"
        action={untagged > 0 && !tag.busy ? { label: `TAG UNTAGGED · ${untagged}`, onClick: () => void onTag() } : undefined}
      />
    )
  else statsBody = <TagStatsTable stats={stats} onTag={onTagRow} selectedTag={tagFilter} />

  return (
    <div className="max-w-[1440px] mx-auto px-3 pb-3 md:px-[var(--gutter)] md:pb-[var(--gutter)] flex flex-col">
      <TerminalTabs />
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-3 items-start">
        <div className="lg:col-span-12">
          <JournalBar
            count={journal.data ? trades.length : null}
            days={days}
            onDays={setDays}
            sources={journal.data?.sources ?? []}
            untagged={untagged}
            onTag={() => void onTag()}
            tagging={tag.busy}
            tagError={tag.error ?? tagError}
            tagNote={tagNote}
          />
        </div>

        <div className="lg:col-span-5 min-w-0">
          <ReportCard
            report={report.data}
            loading={report.loading}
            loadError={report.error}
            offline={report.offline}
            onRetry={report.refetch}
            onGenerate={() => void onGenerate()}
            generating={generate.busy}
            generateError={generate.error}
            onPickTrade={onPickTrade}
          />
        </div>

        <Panel className="lg:col-span-7 min-w-0">
          <PanelHeader title="BY TAG">
            <span className="label">RANKED BY EXPECTANCY</span>
          </PanelHeader>
          {statsBody}
        </Panel>

        <Panel className="lg:col-span-8 min-w-0 scroll-mt-[100px]" id="journal-trades">
          <PanelHeader title="TRADES" />
          {journal.error && journal.data && <ErrorBlock message={journal.error} onRetry={journal.refetch} />}
          {tagFilter && (
            <div className="px-3 py-2 border-b border-border-subtle">
              <Button tier="ghost" onClick={() => patchParams({ tag: null })} aria-label={`clear tag filter ${tagFilter}`}>
                TAG: {tagFilter} ✕
              </Button>
            </div>
          )}
          {tradesBody}
        </Panel>

        <div ref={detailRef} className="lg:col-span-4 min-w-0 lg:sticky lg:top-[92px] scroll-mt-[100px]">
          <Panel>
            <PanelHeader title="TRADE" />
            {selected ? <TradeDetail trade={selected} onNoteSaved={onNoteSaved} /> : <EmptyBlock label="select a trade" />}
          </Panel>
        </div>
      </div>
    </div>
  )
}
