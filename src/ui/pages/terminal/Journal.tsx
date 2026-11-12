import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import { Panel, PanelHeader, Button, HowToRead, type Term } from '../../components'
import { AsyncBody, EmptyBlock } from '../../components/state'
import { TerminalTabs } from '../../components/intel/TerminalTabs'
import { JournalBar, type JournalDays } from '../../components/intel/JournalBar'
import { ReportCard } from '../../components/intel/ReportCard'
import { TagStatsTable } from '../../components/intel/TagStatsTable'
import { TradeDetail } from '../../components/intel/TradeDetail'
import { isDesktop } from '../../components/intel/format'
import { TradesTable, matchesTag, tradeAnchorId, UNTAGGED_TAG } from '../../components/intel/TradesTable'
import { useAction } from '../../components/intel/useAction'
import { useQueryPatch } from '../../lib/hooks'
import { intel, journalTakeaway, useIntel } from '../../lib/intel'
import type { JournalResponse, TradeNote } from '../../../shared/intel'

// `/journal` — what my own trades say (DESIGN-terminal §4). `?trade=<id>`
// selects a trade, `?tag=<tag>` filters; both written with replace. Loads on
// mount + after a write (§1.4). Mobile order: bar → report → by tag → trades
// → trade (the detail scrolls into view once when a row is picked).

const DAYS_KEY = 'ht_journal_days'

const JOURNAL_TERMS: Term[] = [
  ['TRADES', 'Round trips rebuilt from fills: every trade closed in the window, plus any still open. Scaling in or out stays one trade until the position is flat.'],
  ['7D / 30D / 90D', 'The window: trades closed in the last 7, 30 or 90 days.'],
  ['HL / DESK dots', 'Where fills come from: the watched Hyperliquid account and the desk book. A red dot means that source could not be read, so its trades are missing.'],
  ['TAG UNTAGGED · n', 'Asks the model to label the setup type of each of the n untagged trades from a fixed list (breakout, pullback, mean_reversion, scalp and so on). It labels; it does not compute any number.'],
]

const BY_TAG_TERMS: Term[] = [
  ['TAG', 'Setup type of the trades in the row. FEW marks a row with fewer than 5 trades: too few to read anything into.'],
  ['N', 'Closed trades with that tag in the window.'],
  ['EXP', 'Expectancy: the mean result per trade. Shown in R when stops are known, else in USD per trade after fees. Rows are ranked by mean USD per trade, best first.'],
  ['WIN', 'Share of the trades that made money after fees.'],
  ['AVG R', 'Mean R over the trades with a known stop. R is profit or loss after fees divided by what the trade risked from entry to stop: +1R made the risked amount, −1R lost it.'],
  ['HOLD', 'Mean time from first entry to flat.'],
  ['MAE / MFE', 'Mean worst move against the trade and mean best move in its favour while it was open, in percent of the entry price, from 1-hour candles.'],
]

const TRADES_TERMS: Term[] = [
  ['COIN', 'The coin and the account the trade was on (hl or desk).'],
  ['R', 'Profit or loss after fees divided by the amount risked from entry to stop. A dash means no stop is known for the trade.'],
  ['CLOSED / OPENED', 'Time the position went flat and time of the first entry, UTC. OPEN means it is not flat yet.'],
  ['HOLD', 'Time from first entry to flat.'],
  ['MAE/MFE', 'Worst move against the trade, then best move in its favour, while it was open. In R when a stop is known, else in percent of entry. From 1-hour candles.'],
  ['TAGS', 'Setup type the model assigned.'],
  ['PNL', 'Realized profit or loss in USD after fees.'],
  ['SESSION', 'Hour of the entry in the server time zone (UTC unless configured): ASIA 00 to 08, EU 08 to 13, US 13 to 21, OFF 21 to 24.'],
  ['NOTE', 'Your own note on the trade.'],
]

const TRADE_TERMS: Term[] = [
  ['FEES', 'Fees paid on the trade, already included in PNL.'],
  ['ENTRY / EXIT', 'Size-weighted average entry and exit price.'],
  ['STOP', 'The stop used to compute R: the order\'s stop for desk trades, a captured stop order or a manual stop for Hyperliquid trades.'],
  ['FUNDING z / OI z', 'Where funding and open interest stood at entry against the 7 days before it, in standard deviations. Positive is above that week\'s average. A dash means under 24 samples.'],
  ['24H', 'Price change over the 24 hours before entry.'],
  ['OBS / HYP line', 'The model\'s one-line summary of your note. OBS is a sourced observation, HYP is the model\'s inference.'],
]

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
  const [params] = useSearchParams()
  const patchParams = useQueryPatch()
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

  const takeaway = journal.data ? journalTakeaway(trades, days) : null

  // ── tag stats body ──
  const statsEmpty = {
    label: 'No tagged trades in this window. Run TAG UNTAGGED to have the model label each trade\'s setup type; the table then ranks the types.',
    action: untagged > 0 && !tag.busy ? { label: `TAG UNTAGGED · ${untagged}`, onClick: () => void onTag() } : undefined,
  }

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
          <div className="flex flex-col gap-1 px-1 pt-2 min-w-0">
            {takeaway && (
              <p className="m-0 text-md text-text-primary tabular" data-testid="journal-takeaway">
                {takeaway}
              </p>
            )}
            <HowToRead terms={JOURNAL_TERMS}>
              Your own closed trades, measured: which kinds of setup made or lost money, and how each trade went against its stop. Use BY TAG for the pattern
              and TRADES for the single trades behind it.
            </HowToRead>
          </div>
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
          <HowToRead className="px-3 pt-2" terms={BY_TAG_TERMS}>
            One row per setup type, best mean result first. Read N before EXP: a row with few trades says little. Click a row to list its trades.
          </HowToRead>
          <AsyncBody {...journal} offline={!!journal.offline} staleError={false} empty={statsEmpty} isEmpty={() => stats.every((s) => s.tag === UNTAGGED_TAG)} onRetry={journal.refetch}>
            {() => <TagStatsTable stats={stats} onTag={onTagRow} selectedTag={tagFilter} />}
          </AsyncBody>
        </Panel>

        <Panel className="lg:col-span-8 min-w-0 scroll-mt-[calc(var(--topbar-h)+var(--subnav-h)+8px)]" id="journal-trades">
          <PanelHeader title="TRADES" />
          <HowToRead className="px-3 pt-2" terms={TRADES_TERMS}>
            Every trade in the window, open ones first, then newest close first. R compares the result with what the trade risked; click a row for the full
            record and your note.
          </HowToRead>
          {tagFilter && (
            <div className="px-3 py-2 border-b border-border-subtle">
              <Button tier="ghost" onClick={() => patchParams({ tag: null })} aria-label={`clear tag filter ${tagFilter}`}>
                TAG: {tagFilter} ✕
              </Button>
            </div>
          )}
          <AsyncBody
            {...journal}
            offline={!!journal.offline}
            rows={4}
            empty={{ label: `No trades closed in the last ${days} days. Trades are rebuilt from fills on the watched Hyperliquid account and the desk book.` }}
            isEmpty={() => trades.length === 0}
            onRetry={journal.refetch}
          >
            {() => <TradesTable trades={trades} selectedId={selectedId} tagFilter={tagFilter} onSelect={onSelectRow} />}
          </AsyncBody>
        </Panel>

        <div ref={detailRef} className="lg:col-span-4 min-w-0 lg:sticky lg:top-[calc(var(--topbar-h)+var(--subnav-h))] scroll-mt-[calc(var(--topbar-h)+var(--subnav-h)+8px)]">
          <Panel>
            <PanelHeader title="TRADE" />
            {selected ? (
              <>
                <HowToRead className="px-3 pt-2" terms={TRADE_TERMS}>
                  The selected trade in full, with the market conditions at entry and your note.
                </HowToRead>
                <TradeDetail trade={selected} onNoteSaved={onNoteSaved} />
              </>
            ) : (
              <EmptyBlock label="Select a row in TRADES to see its prices, stop, conditions at entry and your note." />
            )}
          </Panel>
        </div>
      </div>
    </div>
  )
}
