import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { AsyncBody, Badge, Button, DataTable, EmptyBlock, ErrorBlock, HowToRead, Panel, PanelHeader, RuleText, Segmented, SkeletonRows, type Column, type Term } from '../components'
import { LabWarnings } from '../components/LabWarnings'
import { useLabData } from '../components/lab/LabData'
import { SaveToCatalogueForm } from '../components/lab/SaveToCatalogueForm'
import { DataTo, DirectionWord } from '../components/lab/common'
import { defaultRuleName, fmtSigned, lab, signTone, TRANSFORM_TERMS, useLab, wireText, type CatalogueEntry, type LabState, type MetricDef, type Rule, type StudyResult } from '../lib/lab'
import { concreteRule, DEFAULT_TOP, exitParams, exitsForm, exitValue, fmtR, parseExitParams, parseRuleParam, realCoin, ruleDrillHref, screenLine, STUDY_HOLDOUT_SHARE, STUDY_MIN_WEEKS, studyHref, studyLine, studyRoute, studyVerdict, type StudyExits, type StudyUniverse } from '../lib/study'
import { STUDY_DEFAULTS, STUDY_EXIT_MAX, type DefinitionsResponse } from '../../shared/research'
import { research } from '../lib/research'
import { StudyVerdictBadge } from '../components/lab/StudyVerdictBadge'
import { InCatalogueLink } from '../components/lab/InCatalogueLink'
import { SetupReplay } from '../components/lab/SetupReplay'

// /lab/study — the event study of one rule (docs/RESEARCH.md "Study"): the
// rule replayed as discrete trades across a universe of coins by
// lab_event_study. Input is `?rule=` (URL-encoded JSON, zod-parsed) and an
// optional `?coin=`; studyHref() in lib/study.ts builds the link. A signal definition's rule has the placeholder
// asset UNIVERSE_ASSET: it defaults to the top-N universe, "this coin" appears only with `?coin=`, and OPEN RULE /
// SAVE need a real asset (concreteRule). The DEFINITIONS picker lists the shipped definitions; INTRADAY SETUPS ·
// REPLAY (SetupReplay) sits under it, loads only here and never blocks the study. Output in
// the brief's order: rule, verdict + screen line, train vs holdout, funnel,
// per-coin table, events, survivorship, idea n of N. The run can take tens of
// seconds; leaving the page aborts the wait (useLab's signal).

type Screen = StudyResult['screen']
type CoinRow = StudyResult['coins'][number]
type EventRow = StudyResult['eventList'][number]

const GUIDE = 'px-3 py-2 border-b border-border-subtle'
const EARLY_PCT = Math.round((1 - STUDY_HOLDOUT_SHARE) * 100)

// Reading guides (HowToRead): every head, badge and number the page prints, as the engine computes it
// (src/server/lab/engine/eventStudy.ts). Cut-offs come from lib/study.ts, which mirrors the engine under test.
const WHAT_IT_IS =
  'An event study replays one rule as separate trades on daily bars: in at the close of a day its conditions are true, out at the stop, the target or the end of the hold. It answers one question: did this lose money in the past. It is history, not a forecast.'

const RULE_TERMS: readonly Term[] = [
  ['LONG / SHORT · 7D HOLD', 'the side every replayed trade takes and the most days it is held. After an entry the rule waits that many days before it can enter the same coin again, so trades never overlap.'],
  ...TRANSFORM_TERMS,
  ['UNIVERSE', `the markets replayed: this coin only, the top N Hyperliquid perps by daily volume (default ${DEFAULT_TOP}), or my markets (the server's configured list). More coins give more trades, but a universe result is not one coin's own history.`],
  ['EXITS · ATR', `stop and target as multiples of ATR, the coin's average daily range over the 14 days up to entry. Defaults: stop ${STUDY_DEFAULTS.stopAtr}, target ${STUDY_DEFAULTS.targetAtr}. A rule that sets its own stop or target keeps it.`],
  ['RUN', 'runs the study again with the edited exits. Every run is recorded as a trial: the more ideas are tried, the likelier one looks good by luck.'],
  ['RAW', 'the rule as stored: metric|transform|window, operator, threshold.'],
  ['OPEN RULE, SAVE', 'OPEN RULE scores the same rule as an always-on daily strategy: equity curve, walk-forward, holdout and sensitivity. SAVE adds it to the catalogue, which then tracks it on new data from the save date.'],
]

const VERDICT_TERMS: readonly Term[] = [
  ['CLEAR', `${studyVerdict('clear').text}.`],
  ['REJECTED', `${studyVerdict('rejected').text}.`],
  ['INSUFFICIENT', `fewer than ${STUDY_MIN_WEEKS} weeks with trades, so the screen gives no verdict.`],
  ['events', 'replayed trades, pooled over every studied coin.'],
  ['weeks', 'calendar weeks holding at least one event. Trades in the same week move together, so each week is averaged first and counts once.'],
  ['R', 'result in units of risk: 1R is the distance from entry to stop. +0.5R is a gain of half the amount risked, −1R a full stop-out. Every R here is after fees, slippage and funding.'],
  ['expectancy', 'the mean of the weekly averages, in R: what the average trade made.'],
  ['upper95', 'one-sided 95% upper bound of the expectancy: the true average is unlikely to be higher. Below 0 means the rule lost beyond reasonable doubt.'],
  ['screen', 'this test can only reject. A rule that is not rejected has not been shown to work, and nothing in the app is blocked or allowed by the result.'],
]

const SPLIT_TERMS: readonly Term[] = [
  ['TRAIN', `events dated in the earlier ${EARLY_PCT}% of the studied period.`],
  ['HOLDOUT', `events dated in the most recent ${100 - EARLY_PCT}% of the period. This is a different cut from the rule drill's holdout, which is the last 20% of days.`],
  ['EVENTS / WEEKS', 'trades in that part, and the calendar weeks that hold them.'],
  ['EXPECTANCY', 'mean of the weekly average result per trade, in R, after costs.'],
  ['UPPER 95%', 'one-sided 95% upper bound of that mean. With few weeks it is wide.'],
]

const FUNNEL_TERMS: readonly Term[] = [
  ['coin-days', 'one coin on one day. The count is how many coin-days pass this condition and every condition above it.'],
  ['−93%', 'the share of the previous step\'s coin-days this condition removes (the first step: of all coin-days).'],
  ['BOTTLENECK', 'the condition that removes the largest share. Loosening it adds the most events.'],
]

const COIN_TERMS: readonly Term[] = [
  ['EVENTS', 'trades the rule made on this coin.'],
  ['STATUS', 'OK = studied. INSUFFICIENT = left out: too few daily bars with a close and funding, or a metric the rule reads is missing for this coin. REASON gives the numbers.'],
  ['REASON', 'why a coin was left out or cut short.'],
  ['BARS', 'daily bars with both a close and funding.'],
  ['RANGE', 'first and last of those bars.'],
]

const EVENT_TERMS: readonly Term[] = [
  ['DATE', 'the day the conditions were true. Entry is at that day\'s close.'],
  ['R', 'the trade\'s result in units of risk after fees, slippage and funding. A * means stop and target were both inside one daily bar: it is scored as the stop.'],
  ['EXIT', 'STOP = stop hit; TARGET = target hit; INVALIDATION = the rule\'s own invalidation was true at a close, out at the next open; HORIZON = neither hit, out at the close of the last day of the hold.'],
  ['FUNDING R', 'the part of R that is funding over the hold. Negative means funding was paid.'],
]


export function LabStudy() {
  const [params] = useSearchParams()
  const raw = params.get('rule')
  const coinParam = params.get('coin')
  // A new rule or coin is a new study: fresh universe, no previous result shown under it.
  return <StudyPage key={`${raw ?? ''}|${coinParam ?? ''}`} raw={raw} coinParam={coinParam} />
}

function StudyPage({ raw, coinParam }: { raw: string | null; coinParam: string | null }) {
  const { metrics, catalogue } = useLabData()
  const [params, setParams] = useSearchParams()
  const parsed = useMemo(() => parseRuleParam(raw), [raw])
  const rule = parsed.rule
  const coin = realCoin(coinParam) || realCoin(rule?.asset)
  const [universe, setUniverse] = useState<StudyUniverse>(() => (coinParam ? { kind: 'coin' } : { kind: 'top', n: DEFAULT_TOP }))
  // Exits: the study runs with the URL's (`?stop=&target=`, defaults omitted) so a link reproduces it. Typing only
  // edits the draft; RUN writes it to the URL, which runs it (each run is a trial).
  const stopParam = params.get('stop')
  const targetParam = params.get('target')
  const applied = useMemo(() => parseExitParams(stopParam, targetParam), [stopParam, targetParam])
  const [draft, setDraft] = useState(() => exitsDraft(applied))
  useEffect(() => setDraft(exitsDraft(applied)), [applied])
  const runExits = (e: StudyExits) =>
    setParams((p) => {
      const next = new URLSearchParams(p)
      next.delete('stop')
      next.delete('target')
      for (const [k, v] of exitParams(e)) next.set(k, v)
      return next
    })
  // The board's canonical universes share its cache and trial (studyRoute); other universes call the Lab tool.
  const route = rule ? studyRoute(rule, coin, universe, applied) : null
  // The shipped definitions: the picker, and the intraday replay's links to the daily definition of a setup kind.
  const [picker, setPicker] = useState(false)
  const definitions = useLab(() => research.definitions(), [])
  const key = route ? JSON.stringify(route) : null
  const study = useLab(
    route
      ? (signal) =>
          route.kind === 'board'
            ? research.run(route.body).then((r) => ({ ...(r.study as unknown as StudyResult), catalogueId: r.catalogueId }))
            : lab.eventStudy(route.args, signal)
      : null,
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
      exits={{ applied, draft, onDraft: setDraft, onRun: runExits }}
      study={study}
      definitions={definitions}
      pickerOpen={picker}
      onPicker={setPicker}
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
  exits: ExitsProps
  study: Pick<LabState<StudyResult>, 'data' | 'loading' | 'error' | 'offline' | 'refetch'>
  definitions: Pick<LabState<DefinitionsResponse>, 'data' | 'loading' | 'error' | 'offline' | 'refetch'>
  /** The DEFINITIONS picker over a loaded rule (the empty state always shows it). */
  pickerOpen: boolean
  onPicker: (open: boolean) => void
  metrics: readonly MetricDef[]
  onSaved?: (e: CatalogueEntry) => void
}

export function StudyView({ parsedError, rule, coin, coinParam = null, universe, onUniverse, exits, study, definitions, pickerOpen, onPicker, metrics, onSaved }: StudyViewProps) {
  const navigate = useNavigate()
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState<CatalogueEntry | null>(null)

  if (!rule) {
    return (
      <div className="flex flex-col gap-3 min-w-0">
        <Panel>
          <PanelHeader title="EVENT STUDY" />
          <HowToRead className={GUIDE}>{WHAT_IT_IS} Nothing shows yet because no rule is loaded: the verdict, the trades and the per-coin table appear once you pick one.</HowToRead>
          {parsedError && <ErrorBlock message={parsedError} />}
          <EmptyBlock label="no rule to study — pick a definition below, or open a rule from a search result or the catalogue" />
          <div className="flex flex-wrap justify-center gap-2 px-3 pb-6">
            <Button tier="ghost" onClick={() => navigate('/lab/search')}>
              SEARCH
            </Button>
            <Button tier="ghost" onClick={() => navigate('/lab/catalogue')}>
              CATALOGUE
            </Button>
          </div>
        </Panel>
        <DefinitionsPicker definitions={definitions} />
        <SetupReplay definitions={definitions} />
      </div>
    )
  }

  const running = study.loading
  const r = study.data
  // Already catalogued (the server's catalogueId, or saved here): a link to the entry instead of a second SAVE.
  const inCatalogue = saved?.id ?? r?.catalogueId ?? null
  // A definition's rule has a placeholder asset: OPEN RULE and SAVE need a real one (`?coin=`).
  const real = concreteRule(rule, coinParam)
  const needCoin = 'a universe definition has no coin of its own: add ?coin=<TICKER> to the link to open or save it for one coin'

  return (
    <div className="flex flex-col gap-3 min-w-0">
      <Panel>
        <div className="flex flex-col gap-2 p-3 min-w-0">
          <RuleText rule={rule} metrics={metrics} size="lg" className="text-text-primary break-words" />
          <p className="text-xs text-text-secondary">
            <DirectionWord direction={rule.direction} /> · {rule.horizonDays}D HOLD · EVENT STUDY
          </p>
          <p className="text-xs text-text-secondary break-all" title="the rule as stored: metric|transform|window, operator, threshold">
            RAW {r?.text ?? wireText(rule)}
          </p>
          <HowToRead terms={RULE_TERMS}>{WHAT_IT_IS}</HowToRead>
          <div className="flex flex-wrap items-end gap-2">
            <UniverseControl coin={coin} universe={universe} onChange={onUniverse} />
            <ExitsControl {...exits} />
            <div className="flex flex-wrap gap-2">
              <Button tier="ghost" disabled={!real} onClick={() => real && navigate(ruleDrillHref(real, coinParam, exits.applied))} title={real ? 'rule drill: equity, stats by window, sensitivity' : needCoin}>
                OPEN RULE
              </Button>
              <Button tier="ghost" aria-expanded={pickerOpen} onClick={() => onPicker(!pickerOpen)} title="the shipped signal definitions, prefilled over the top-N universe">
                DEFINITIONS
              </Button>
              {inCatalogue ? (
                <InCatalogueLink id={inCatalogue} />
              ) : (
                <Button tier="ghost" disabled={!real} aria-expanded={saving} onClick={() => setSaving((s) => !s)} title={real ? undefined : needCoin}>
                  SAVE
                </Button>
              )}
            </div>
          </div>
        </div>
        {!real && <p className="px-3 pb-3 text-xs text-text-secondary">{needCoin}</p>}
        {saving && real && !inCatalogue && (
          <div className="border-t border-border-subtle">
            <p className="px-3 pt-3 text-xs text-text-secondary">the save-bar verdict still applies: saving evaluates the rule; check it on OPEN RULE</p>
            <SaveToCatalogueForm
              rule={real}
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

      {pickerOpen && <DefinitionsPicker definitions={definitions} />}

      {running && <RunningLine />}

      <AsyncBody {...study} onRetry={study.refetch} skeleton={<StudySkeleton />}>
        {(d) => (
          <div className={`flex flex-col gap-3 min-w-0 ${running ? 'opacity-70' : ''}`} aria-busy={running || undefined}>
            <StudyResultView result={d} />
          </div>
        )}
      </AsyncBody>

      <SetupReplay definitions={definitions} />
    </div>
  )
}

/** The shipped signal definitions (GET /api/research/definitions): picking one opens its prefilled study over the default universe. */
function DefinitionsPicker({ definitions }: { definitions: StudyViewProps['definitions'] }) {
  return (
    <Panel>
      <PanelHeader title="DEFINITIONS" />
      <HowToRead className={GUIDE}>
        The signal definitions shipped with the app, each a fixed rule on daily bars with its one-line idea. Picking one opens its event study over the top-{DEFAULT_TOP} universe; the study
        runs on load and counts as a trial. The thresholds are starting points to study, not claims.
      </HowToRead>
      <AsyncBody {...definitions} onRetry={definitions.refetch} rows={3} isEmpty={(d) => d.definitions.length === 0} empty={{ label: 'no definitions shipped' }}>
        {(d) => (
          <ul className="flex flex-col">
            {d.definitions.map((x) => (
              <li key={x.id} className="border-b border-border-subtle last:border-b-0">
                <Link to={studyHref(x.rule)} title="open the event study of this definition over the top-20 universe; it runs on load (a trial)" className="flex flex-col gap-0.5 px-3 py-2 min-w-0 hover:bg-hover">
                  <span className="text-sm font-semibold text-text-primary">{x.name}</span>
                  <span className="text-xs text-text-secondary break-words">{x.thesis}</span>
                  <span className="text-xs text-text-secondary break-words font-mono">{x.ruleText}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </AsyncBody>
    </Panel>
  )
}

function UniverseControl({ coin, universe, onChange }: { coin: string; universe: StudyUniverse; onChange: (u: StudyUniverse) => void }) {
  const [draft, setDraft] = useState(String(universe.kind === 'top' ? universe.n : DEFAULT_TOP))
  const n = Number(draft)
  const valid = Number.isInteger(n) && n >= 1 && n <= 300
  const commit = () => valid && onChange({ kind: 'top', n })
  const topN = universe.kind === 'top' ? universe.n : valid ? n : DEFAULT_TOP
  return (
    <div className="flex flex-col gap-1 min-w-0">
      <span className="label">UNIVERSE</span>
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          label="universe"
          value={universe.kind}
          onChange={(k) => onChange(k === 'top' ? { kind: 'top', n: topN } : { kind: k })}
          options={[
            // No real coin (a definition without `?coin=`): the option is not offered, never a coin called UNIVERSE.
            ...(coin ? [{ value: 'coin' as const, label: `THIS COIN · ${coin}`, short: coin, title: `${coin} only` }] : []),
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

const exitsDraft = (e: StudyExits) => ({ stop: String(e.stopAtr), target: String(e.targetAtr) })

export interface ExitsProps {
  /** The exits the shown study runs with (the URL's). */
  applied: StudyExits
  draft: { stop: string; target: string }
  onDraft: (d: { stop: string; target: string }) => void
  /** Puts the exits in the URL, which runs the study. */
  onRun: (e: StudyExits) => void
}

/** Stop and target in ATR. Editing never runs a study: RUN does, once the draft is valid and differs (exitsForm). */
function ExitsControl({ applied, draft, onDraft, onRun }: ExitsProps) {
  const f = exitsForm(draft, applied)
  const run = () => f.canRun && f.exits && onRun(f.exits)
  const field = (key: 'stop' | 'target', label: string, max: number) => (
    <label className="flex items-center gap-1">
      <span className="label">{label}</span>
      <input
        type="number"
        inputMode="decimal"
        step={0.1}
        min={0.1}
        max={max}
        value={draft[key]}
        onChange={(e) => onDraft({ ...draft, [key]: e.target.value })}
        onKeyDown={(e) => e.key === 'Enter' && run()}
        aria-invalid={exitValue(draft[key], max) == null || undefined}
        className="w-[7ch]"
      />
    </label>
  )
  return (
    <div className="flex flex-col gap-1 min-w-0 mr-auto">
      <span className="label">EXITS · ATR</span>
      <div className="flex flex-wrap items-center gap-2">
        {field('stop', 'STOP', STUDY_EXIT_MAX.stopAtr)}
        {field('target', 'TARGET', STUDY_EXIT_MAX.targetAtr)}
        <Button tier="neutral" disabled={!f.canRun} onClick={run} title="run the study with these exits: counts as a new trial">
          RUN
        </Button>
      </div>
      {f.error ? (
        <span className="text-sm text-red-text">{f.error}</span>
      ) : f.dirty ? (
        <span className="text-xs text-text-secondary">edited · RUN to study with these exits (each run is a trial)</span>
      ) : null}
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
  { key: 'exp', label: 'EXPECTANCY', priority: 1, align: 'right', render: (x) => <span className={x.s.expectancy == null ? '' : signTone(x.s.expectancy)}>{fmtR(x.s.expectancy)}</span> },
  { key: 'up', label: 'UPPER 95%', priority: 2, align: 'right', render: (x) => fmtR(x.s.upper95) },
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
          <p className="text-md text-text-primary">{studyLine(d)}</p>
          <p className="flex flex-wrap items-center gap-2">
            <StudyVerdictBadge verdict={d.verdict} />
            <span className="text-sm text-text-secondary">{v.text}</span>
          </p>
          <p className="tabular text-base text-text-primary">{screenLine(d.screen)}</p>
          <p className="text-xs text-text-secondary">
            weeks pooled over all coins · one-sided 95% upper bound · the screen can only reject and blocks nothing
          </p>
          <HowToRead terms={VERDICT_TERMS}>
            The badge is the screen's verdict and the line under it is the evidence: how many past trades, over how many weeks, what the average one made and how high that average
            could plausibly be.
          </HowToRead>
        </div>
      </Panel>

      <Panel>
        <PanelHeader title="TRAIN VS HOLDOUT" />
        <HowToRead terms={SPLIT_TERMS} className={GUIDE}>
          The same numbers split by date: the earlier {EARLY_PCT}% of the period against the most recent {100 - EARLY_PCT}%. The rule was given, not fitted to either part, so this only shows
          whether the result held up later.
        </HowToRead>
        <DataTable columns={screenCols} rows={[{ k: 'TRAIN', s: d.train }, { k: 'HOLDOUT', s: d.holdout }]} rowKey={(x) => x.k} />
        <p className="px-3 py-2 text-xs text-text-secondary">
          {d.period ? `${d.period.from} → ${d.period.to} · holdout from ${d.period.holdoutFrom} (last 30% by time)` : 'no period — no coin had enough data'} · facts, not a
          second verdict
        </p>
      </Panel>

      <Panel>
        <PanelHeader title="CONDITION FUNNEL" />
        <HowToRead terms={FUNNEL_TERMS} className={GUIDE}>
          How rare each condition is: the rule's conditions applied one after another, with how many coin-days are left after each. It shows which condition decides how often the rule
          fires.
        </HowToRead>
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
        <HowToRead terms={COIN_TERMS} className={GUIDE}>
          Which coins the study covered and how many trades each gave. A result carried by one or two coins is weaker than one spread across many.
        </HowToRead>
        <DataTable columns={coinCols} rows={d.coins} rowKey={(c) => c.coin} sortable defaultSort={{ key: 'events', dir: 'desc' }} emptyLabel={<EmptyBlock label="no coins studied: none had the data this rule reads" />} />
      </Panel>

      <Panel>
        <PanelHeader title="EVENTS">
          <span className="text-xs tabular text-text-secondary">
            {shown < d.eventListTotal ? `${shown} of ${d.eventListTotal.toLocaleString('en-US')} · most recent` : `${d.eventListTotal}`}
          </span>
        </PanelHeader>
        <HowToRead terms={EVENT_TERMS} className={GUIDE}>
          Every replayed trade, newest first: when it entered, how it ended and what it made in units of risk. A long list is cut to the most recent trades (the header gives the counts); the verdict uses all of them.
        </HowToRead>
        <DataTable columns={eventCols} rows={d.eventList} rowKey={(e) => `${e.coin}|${e.date}`} sortable defaultSort={{ key: 'date', dir: 'desc' }} emptyLabel={<EmptyBlock label="no events: the rule's conditions were never all true on these coins, so there is no trade to list" />} />
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
        <span> · this rule's first recorded trial out of every trial recorded. Each idea tried raises the odds that one looks good by luck.</span>
      </p>
    </div>
  )
}
