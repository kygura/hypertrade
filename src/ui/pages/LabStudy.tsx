import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { AsyncBody, Badge, Button, DataTable, EmptyBlock, ErrorBlock, Panel, PanelHeader, RuleText, Segmented, SkeletonRows, type Column } from '../components'
import { LabWarnings } from '../components/LabWarnings'
import { useLabData } from '../components/lab/LabData'
import { SaveToCatalogueForm } from '../components/lab/SaveToCatalogueForm'
import { DataTo, DirectionWord } from '../components/lab/common'
import { defaultRuleName, fmtSigned, lab, signTone, useLab, wireText, type CatalogueEntry, type LabState, type MetricDef, type Rule, type StudyResult } from '../lib/lab'
import { DEFAULT_TOP, fmtR, parseRuleParam, ruleDrillHref, screenLine, studyRoute, studyVerdict, type StudyUniverse } from '../lib/study'
import { research } from '../lib/research'
import { StudyVerdictBadge } from '../components/lab/StudyVerdictBadge'

// /lab/study — the event study of one rule (docs/RESEARCH.md "Study"): the
// rule replayed as discrete trades across a universe of coins by
// lab_event_study. Input is `?rule=` (URL-encoded JSON, zod-parsed) and an
// optional `?coin=`; studyHref() in lib/study.ts builds the link. Output in
// the brief's order: rule, verdict + screen line, train vs holdout, funnel,
// per-coin table, events, survivorship, idea n of N. The run can take tens of
// seconds; leaving the page aborts the wait (useLab's signal).

type Screen = StudyResult['screen']
type CoinRow = StudyResult['coins'][number]
type EventRow = StudyResult['eventList'][number]


export function LabStudy() {
  const [params] = useSearchParams()
  const raw = params.get('rule')
  const coinParam = params.get('coin')
  // A new rule or coin is a new study: fresh universe, no previous result shown under it.
  return <StudyPage key={`${raw ?? ''}|${coinParam ?? ''}`} raw={raw} coinParam={coinParam} />
}

function StudyPage({ raw, coinParam }: { raw: string | null; coinParam: string | null }) {
  const { metrics, catalogue } = useLabData()
  const parsed = useMemo(() => parseRuleParam(raw), [raw])
  const rule = parsed.rule
  const coin = coinParam || rule?.asset || ''
  const [universe, setUniverse] = useState<StudyUniverse>(() => (coinParam ? { kind: 'coin' } : { kind: 'top', n: DEFAULT_TOP }))
  // The board's canonical studies share its cache and trial (studyRoute); other universes call the Lab tool.
  const route = rule ? studyRoute(rule, coin, universe) : null
  const key = route ? JSON.stringify(route) : null
  const study = useLab(
    route ? (signal) => (route.kind === 'board' ? research.run(route.body).then((r) => r.study as unknown as StudyResult) : lab.eventStudy(route.args, signal)) : null,
    [key],
  )

  return (
    <StudyView
      parsedError={parsed.error}
      rule={rule}
      coin={coin}
      coinParam={coinParam}
      universe={universe}
      onUniverse={setUniverse}
      study={study}
      metrics={metrics.data ?? []}
      onSaved={() => catalogue.refetch()}
    />
  )
}

export interface StudyViewProps {
  parsedError: string | null
  rule: Rule | null
  coin: string
  coinParam?: string | null
  universe: StudyUniverse
  onUniverse: (u: StudyUniverse) => void
  study: Pick<LabState<StudyResult>, 'data' | 'loading' | 'error' | 'offline' | 'refetch'>
  metrics: readonly MetricDef[]
  onSaved?: (e: CatalogueEntry) => void
}

export function StudyView({ parsedError, rule, coin, coinParam = null, universe, onUniverse, study, metrics, onSaved }: StudyViewProps) {
  const navigate = useNavigate()
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState<CatalogueEntry | null>(null)

  if (!rule) {
    return (
      <Panel>
        <PanelHeader title="EVENT STUDY" />
        {parsedError && <ErrorBlock message={parsedError} />}
        <EmptyBlock label="no rule to study — open one from a search result or the catalogue" />
        <div className="flex flex-wrap justify-center gap-2 px-3 pb-6">
          <Button tier="ghost" onClick={() => navigate('/lab/search')}>
            SEARCH
          </Button>
          <Button tier="ghost" onClick={() => navigate('/lab/catalogue')}>
            CATALOGUE
          </Button>
        </div>
      </Panel>
    )
  }

  const running = study.loading
  const r = study.data

  return (
    <div className="flex flex-col gap-3 min-w-0">
      <Panel>
        <div className="flex flex-col gap-2 p-3 min-w-0">
          <RuleText rule={rule} metrics={metrics} size="lg" className="text-text-primary break-words" />
          <p className="text-xs text-text-secondary">
            <DirectionWord direction={rule.direction} /> · {rule.horizonDays}D HOLD · EVENT STUDY
          </p>
          <p className="text-xs text-text-secondary break-all">RAW {r?.text ?? wireText(rule)}</p>
          <div className="flex flex-wrap items-end gap-2">
            <UniverseControl coin={coin} universe={universe} onChange={onUniverse} />
            <div className="flex flex-wrap gap-2">
              <Button tier="ghost" onClick={() => navigate(ruleDrillHref(rule, coinParam))} title="rule drill: equity, stats by window, sensitivity">
                OPEN RULE
              </Button>
              <Button tier="ghost" aria-expanded={saving} onClick={() => setSaving((s) => !s)}>
                {saved ? 'SAVED ✓' : 'SAVE'}
              </Button>
            </div>
          </div>
        </div>
        {saving && (
          <div className="border-t border-border-subtle">
            <p className="px-3 pt-3 text-xs text-text-secondary">the save-bar verdict still applies: saving evaluates the rule; check it on OPEN RULE</p>
            <SaveToCatalogueForm
              rule={rule}
              runId={null}
              defaultName={defaultRuleName(rule, metrics)}
              entry={saved}
              onSaved={(e) => {
                setSaved(e)
                onSaved?.(e)
              }}
            />
          </div>
        )}
      </Panel>

      {running && <RunningLine />}

      <AsyncBody {...study} onRetry={study.refetch} skeleton={<StudySkeleton />}>
        {(d) => (
          <div className={`flex flex-col gap-3 min-w-0 ${running ? 'opacity-70' : ''}`} aria-busy={running || undefined}>
            <StudyResultView result={d} />
          </div>
        )}
      </AsyncBody>
    </div>
  )
}

function UniverseControl({ coin, universe, onChange }: { coin: string; universe: StudyUniverse; onChange: (u: StudyUniverse) => void }) {
  const [draft, setDraft] = useState(String(universe.kind === 'top' ? universe.n : DEFAULT_TOP))
  const n = Number(draft)
  const valid = Number.isInteger(n) && n >= 1 && n <= 300
  const commit = () => valid && onChange({ kind: 'top', n })
  const topN = universe.kind === 'top' ? universe.n : valid ? n : DEFAULT_TOP
  return (
    <div className="flex flex-col gap-1 min-w-0 mr-auto">
      <span className="label">UNIVERSE</span>
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          label="universe"
          value={universe.kind}
          onChange={(k) => onChange(k === 'top' ? { kind: 'top', n: topN } : { kind: k })}
          options={[
            { value: 'coin', label: `THIS COIN · ${coin}`, short: coin, title: `${coin} only` },
            { value: 'top', label: `TOP ${topN}`, short: `TOP ${topN}`, title: 'the N listed HL perps with the most day volume' },
            { value: 'mine', label: 'MY MARKETS', short: 'MINE', title: 'my markets (PLATFORM_MY_MARKETS)' },
          ]}
        />
        {universe.kind === 'top' && (
          <label className="flex items-center gap-1">
            <span className="label">N</span>
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={300}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => e.key === 'Enter' && commit()}
              aria-invalid={!valid || undefined}
              className="w-[7ch]"
            />
          </label>
        )}
      </div>
      {universe.kind === 'top' && !valid && <span className="text-sm text-red-text">N: 1–300</span>}
    </div>
  )
}

function Elapsed() {
  const [start] = useState(() => Date.now())
  const [now, setNow] = useState(start)
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  return <span className="tabular">{Math.round((now - start) / 1000)} s</span>
}

/** Busy line: elapsed, not progress (the tool has no progress stream). */
export function RunningLine() {
  return (
    <p role="status" className="text-sm text-text-secondary px-1">
      <span className="pulse-label">RUNNING STUDY…</span> <Elapsed /> · daily candles and funding per coin, seconds to tens of seconds · leaving this page stops waiting
    </p>
  )
}

function StudySkeleton() {
  return (
    <>
      {['VERDICT', 'TRAIN VS HOLDOUT', 'PER COIN'].map((t) => (
        <Panel key={t}>
          <PanelHeader title={t} />
          <SkeletonRows rows={2} />
        </Panel>
      ))}
    </>
  )
}

const screenCols: Column<{ k: string; s: Screen }>[] = [
  { key: 'k', label: 'WINDOW', priority: 1, render: (x) => x.k },
  { key: 'events', label: 'EVENTS', priority: 1, align: 'right', render: (x) => x.s.events },
  { key: 'weeks', label: 'WEEKS', priority: 1, align: 'right', render: (x) => x.s.weeks },
  { key: 'exp', label: 'EXP', priority: 1, align: 'right', render: (x) => <span className={x.s.expectancy == null ? '' : signTone(x.s.expectancy)}>{fmtR(x.s.expectancy)}</span> },
  { key: 'up', label: 'UP95', priority: 2, align: 'right', render: (x) => fmtR(x.s.upper95) },
]

const coinCols: Column<CoinRow>[] = [
  { key: 'coin', label: 'COIN', priority: 1, render: (c) => c.coin, sortValue: (c) => c.coin },
  { key: 'events', label: 'EVENTS', priority: 1, align: 'right', render: (c) => c.events, sortValue: (c) => c.events },
  {
    key: 'status',
    label: 'STATUS',
    priority: 2,
    render: (c) => (
      <span title={c.reason}>
        <Badge tone={c.status === 'ok' ? 'gray' : 'amber'}>{c.status === 'ok' ? 'OK' : 'INSUFFICIENT'}</Badge>
      </span>
    ),
  },
  { key: 'reason', label: 'REASON', priority: 3, render: (c) => <span className="text-xs text-text-secondary">{c.reason ?? '—'}</span> },
  { key: 'bars', label: 'BARS', priority: 3, align: 'right', render: (c) => c.bars, sortValue: (c) => c.bars },
  { key: 'range', label: 'RANGE', priority: 4, render: (c) => <span className="text-xs">{c.from && c.to ? `${c.from} → ${c.to}` : '—'}</span> },
]

const eventCols: Column<EventRow>[] = [
  { key: 'date', label: 'DATE', priority: 1, render: (e) => e.date, sortValue: (e) => e.date },
  { key: 'coin', label: 'COIN', priority: 1, render: (e) => e.coin, sortValue: (e) => e.coin },
  {
    key: 'r',
    label: 'R',
    priority: 1,
    align: 'right',
    render: (e) => (
      <span className={signTone(e.r)} title={e.ambiguous ? 'stop and target in one bar: scored as stop' : undefined}>
        {fmtR(e.r)}
        {e.ambiguous && ' *'}
      </span>
    ),
    sortValue: (e) => e.r,
  },
  { key: 'exit', label: 'EXIT', priority: 2, render: (e) => e.exit.toUpperCase() },
  { key: 'exitDate', label: 'EXIT DATE', priority: 3, render: (e) => e.exitDate },
  { key: 'funding', label: 'FUNDING R', priority: 4, align: 'right', render: (e) => fmtR(e.fundingR) },
]

/** The study result, in the brief's order after the rule header. */
export function StudyResultView({ result: d }: { result: StudyResult }) {
  const v = studyVerdict(d.verdict)
  const shown = d.eventList.length
  return (
    <>
      <Panel>
        <PanelHeader title="VERDICT" />
        <LabWarnings warnings={d.warnings} />
        <div className="flex flex-col gap-1 p-3">
          <p className="flex flex-wrap items-center gap-2">
            <StudyVerdictBadge verdict={d.verdict} />
            <span className="text-sm text-text-secondary">{v.text}</span>
          </p>
          <p className="tabular text-base text-text-primary">{screenLine(d.screen)}</p>
          <p className="text-xs text-text-secondary">
            week-clustered over all coins · one-sided 95% upper bound · reject-only screen, gates nothing
          </p>
        </div>
      </Panel>

      <Panel>
        <PanelHeader title="TRAIN VS HOLDOUT" />
        <DataTable columns={screenCols} rows={[{ k: 'TRAIN', s: d.train }, { k: 'HOLDOUT', s: d.holdout }]} rowKey={(x) => x.k} />
        <p className="px-3 py-2 text-xs text-text-secondary">
          {d.period ? `${d.period.from} → ${d.period.to} · holdout from ${d.period.holdoutFrom} (last 30% by time)` : 'no period — no coin had enough data'} · facts, not a
          second verdict
        </p>
      </Panel>

      <Panel>
        <PanelHeader title="CONDITION FUNNEL" />
        {d.funnel.steps.length === 0 ? (
          <EmptyBlock label="no condition steps" />
        ) : (
          <ol className="flex flex-col">
            {d.funnel.steps.map((s, i) => (
              <li key={i} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-1.5 border-b border-border-subtle min-w-0">
                <span className="text-sm text-text-primary tabular break-all min-w-0">{s.condition}</span>
                <span className="text-xs text-text-secondary tabular">
                  {s.survivors.toLocaleString('en-US')} coin-days · −{Math.round(s.dropRel * 100)}%
                </span>
                {i === d.funnel.bottleneck && <Badge tone="amber">BOTTLENECK</Badge>}
              </li>
            ))}
          </ol>
        )}
        <p className="px-3 py-2 text-xs text-text-secondary">coin-days passing each condition and every one before it, over the studied coins</p>
      </Panel>

      <Panel>
        <PanelHeader title={`PER COIN · ${d.coins.length}`} />
        <DataTable columns={coinCols} rows={d.coins} rowKey={(c) => c.coin} sortable defaultSort={{ key: 'events', dir: 'desc' }} emptyLabel={<EmptyBlock label="no coins studied" />} />
      </Panel>

      <Panel>
        <PanelHeader title="EVENTS">
          <span className="text-xs tabular text-text-secondary">
            {shown < d.eventListTotal ? `${shown} of ${d.eventListTotal.toLocaleString('en-US')} · most recent` : `${d.eventListTotal}`}
          </span>
        </PanelHeader>
        <DataTable columns={eventCols} rows={d.eventList} rowKey={(e) => `${e.coin}|${e.date}`} sortable defaultSort={{ key: 'date', dir: 'desc' }} emptyLabel={<EmptyBlock label="no events — the rule never fired on these coins" />} />
      </Panel>

      <StudyFooter result={d} />
    </>
  )
}

function StudyFooter({ result: d }: { result: StudyResult }): ReactNode {
  return (
    <div className="flex flex-col gap-1 px-1 text-xs text-text-secondary">
      <p>{d.survivorship}</p>
      <p>
        historical research · net of {d.feeRoundTripPct}% round-trip fee, {d.slippageBps} bps slippage per side and funding · stop {d.stopAtr} ATR · target{' '}
        {d.targetAtr} ATR unless the rule sets its own
        {d.period ? (
          <>
            {' · '}
            <DataTo date={d.period.to} />
          </>
        ) : null}
      </p>
      <p title="this rule's first recorded trial over every trial recorded (each idea tried counts against the next)">
        idea {d.idea.n} of {d.idea.of}
      </p>
    </div>
  )
}
