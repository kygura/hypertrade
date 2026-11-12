import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router'
import { Button, EmptyBlock, ErrorBlock, HowToRead, OfflineBlock, Panel, PanelHeader, SkeletonRows, StaleBanner, type Term } from '../components'
import { RuleEquityChart, RuleEquityGuide } from '../components/charts/RuleEquityChart'
import { DrawdownChart, DrawdownGuide } from '../components/branches/DrawdownChart'
import { computeDrawdown } from '../components/branches/format'
import { RuleDrillHeader } from '../components/lab/RuleDrillHeader'
import { WINDOW_TERMS, WindowStatsTable } from '../components/lab/WindowStatsTable'
import { SensitivityGrid } from '../components/lab/SensitivityGrid'
import { LatestValuesRow } from '../components/lab/LatestValuesRow'
import { SaveToCatalogueForm } from '../components/lab/SaveToCatalogueForm'
import { InCatalogueLink } from '../components/lab/InCatalogueLink'
import { RemoveRuleDialog } from '../components/lab/RemoveRuleDialog'
import { DataTo, LabFooter, StabValue } from '../components/lab/common'
import {
  benchmarkLabel,
  dateIso,
  defaultRuleName,
  EVAL_TERMS,
  MIN_STABILITY,
  drillEvaluateArgs,
  drillTrialsN,
  freshDsrN,
  fmtSigned,
  isStaleDate,
  lab,
  useLab,
  type CatalogueEntry,
  type CatalogueListEntry,
  type DsrN,
  type LabState,
} from '../lib/lab'
import type { AtSearch } from '../components/lab/WindowStatsTable'
import { catalogueIdIn, parseExitParams, parseRuleParam, studyHref } from '../lib/study'

// /lab/rules/:id — rule drill (docs/design/README.md §10.9). Full-view route like the
// markets drill: linkable from MCP/CLI output, back-button friendly.
// Resolution: ?run=<runId> → lab_get_run and that run's rule with this id;
// else the catalogue entry with this id; else an ad-hoc `?rule=` (OPEN RULE
// from /lab/study: no search-time numbers, only the fresh evaluation); else
// `rule not found`. Then one
// lab_evaluate_rule (equity + sensitivity, `trials` = the search's N) gives
// today's numbers and the server's fresh verdict and DSR; the search-time
// (save-time) walk-forward, DSR and verdict stay beside them, labelled
// AT SEARCH (AT SAVE). The UI never computes a verdict.

const BACK: Record<string, { label: string; to: string }> = {
  results: { label: '← RESULTS', to: '/lab/search' },
  catalogue: { label: '← CATALOGUE', to: '/lab/catalogue' },
  pulse: { label: '← RULES', to: '/lab/catalogue' },
}

const GUIDE = 'px-3 py-2 border-b border-border-subtle'

const SENSITIVITY_TERMS: readonly Term[] = [
  ['THRESHOLD row', 'the same rule with this condition\'s cut-off moved: q−0.10 and q−0.05 are looser or tighter by 10 and 5 percentile points of the metric\'s own history, q+0.05 and q+0.10 the other way. BASE is the rule as written.'],
  ['WINDOW row', 'the same rule with this condition\'s lookback swapped for the next shorter and longer window (w7, w30, w90), keeping the cut-off at the same percentile.'],
  ['top number', 'Sharpe of that variant over the search region (the first 80% of the history).'],
  ['bottom number', 'its total return over the same days.'],
  ['cell colour', 'against the BASE Sharpe: red = the sign flipped, light red = under half of it, neutral = between half and all of it, green = at least as high.'],
  ['STABILITY', EVAL_TERMS.stability[1]],
]

function failed<T>(s: LabState<T>): ReactNode | null {
  if (s.offline && !s.data) return <OfflineBlock onRetry={s.refetch} />
  if (s.error && !s.data) return <ErrorBlock message={s.error} onRetry={s.refetch} />
  return null
}

export function LabRule() {
  const { id = '' } = useParams<{ id: string }>()
  const [params] = useSearchParams()
  const runId = params.get('run')
  const ruleParam = params.get('rule')
  const adhoc = useMemo(() => parseRuleParam(ruleParam).rule, [ruleParam])
  const from = params.get('from') ?? ''
  const back = from === 'study' && adhoc ? { label: '← STUDY', to: studyHref(adhoc, params.get('coin'), parseExitParams(params.get('stop'), params.get('target'))) } : (BACK[from] ?? BACK.results!)
  const navigate = useNavigate()
  const location = useLocation()
  const focusSave = (location.state as { focusSave?: boolean } | null)?.focusSave === true

  const metrics = useLab(() => lab.metrics(), [])
  const catalogue = useLab(() => lab.catalogue(), [])
  const run = useLab(runId ? () => lab.getRun(runId) : null, [runId])
  const [savedEntry, setSavedEntry] = useState<CatalogueEntry | null>(null)
  const [removing, setRemoving] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)
  const saveRef = useRef<HTMLDivElement>(null)

  const listed: CatalogueListEntry | null = catalogue.data?.find((e) => e.id === id) ?? null
  const entry: Pick<CatalogueEntry, 'id' | 'name' | 'savedAt' | 'runId'> | null = savedEntry ?? listed
  const runRule = run.data?.result?.rules.find((r) => r.id === id) ?? null
  const base = runRule ?? listed?.saved ?? null
  const rule = base?.rule ?? adhoc
  const ruleKey = rule ? JSON.stringify(rule) : null
  const slippageBps = run.data?.config.slippageBps
  const windows = run.data?.config.windows

  const settled = (s: Pick<LabState<unknown>, 'data' | 'error' | 'offline'>) => s.data != null || s.error != null || s.offline
  const runSettled = !runId || settled(run)
  const catSettled = settled(catalogue)

  // N of the search behind `base`: the ?run's, else the catalogue entry's run
  // (fetched for its effective trials; 1 when saved without a run, unknown
  // when the run is gone).
  const sourceRunId = runRule ? runId : (listed?.runId ?? null)
  const reuseRun = sourceRunId != null && sourceRunId === runId
  const entryRun = useLab(sourceRunId && !reuseRun ? () => lab.getRun(sourceRunId) : null, [sourceRunId, reuseRun])
  const sourceRun = reuseRun ? run : entryRun
  const trialsN = drillTrialsN({ runId: sourceRunId, run: sourceRun.data, runSettled: settled(sourceRun) })

  // Waits for N so the server deflates the fresh DSR (and builds the fresh
  // verdict) for the search that found the rule.
  const evaluation = useLab(
    rule && trialsN !== undefined ? () => lab.evaluate(drillEvaluateArgs(rule, { trialsN, slippageBps, windows })) : null,
    [ruleKey, trialsN],
  )

  const fresh = evaluation.data
  const evaluating = evaluation.loading || (rule != null && trialsN === undefined)
  // An ad-hoc rule has nothing to show until its evaluation lands.
  const resolving = !base && (!runSettled || !catSettled || (adhoc != null && !fresh && evaluating))
  const current = fresh != null
  const ev = fresh ?? base
  const baseDsrN: DsrN = { n: trialsN ?? null }
  const dsrN: DsrN = current ? freshDsrN(trialsN ?? null) : baseDsrN
  const atSearch: AtSearch | null = base ? { label: runRule ? 'AT SEARCH' : 'AT SAVE', ev: base, dsrN: baseDsrN } : null
  const metricDefs = metrics.data ?? []
  // An ad-hoc rule (/lab/rules/study?rule=…) that is already saved: link to its entry instead of offering SAVE again.
  const adhocCatalogueId = !base && adhoc && !savedEntry ? catalogueIdIn(fresh?.id, catalogue.data) : null
  const defaultName = useMemo(() => (rule ? defaultRuleName(rule, metricDefs) : ''), [ruleKey, metrics.data]) // eslint-disable-line react-hooks/exhaustive-deps

  // Arriving from a card's SAVE: the save form is pre-focused.
  useEffect(() => {
    if (!focusSave || !rule || entry) return
    nameRef.current?.focus()
    saveRef.current?.scrollIntoView({ block: 'center' })
  }, [focusSave, ruleKey, entry == null]) // eslint-disable-line react-hooks/exhaustive-deps

  const backButton = (
    <div className="flex flex-wrap gap-2">
      <Button tier="ghost" onClick={() => navigate(back.to)}>
        {back.label}
      </Button>
      {rule && (
        <Button tier="ghost" onClick={() => navigate(studyHref(rule))} title="event study: the rule as discrete trades across coins">
          STUDY
        </Button>
      )}
    </div>
  )
  const wrap = (children: ReactNode) => <div className="max-w-[1440px] mx-auto p-3 md:p-[var(--gutter)] flex flex-col gap-3">{children}</div>

  if (resolving) {
    // First load: SkeletonRows per panel (§13), in the drill's own layout.
    const skel = (title: string, rows?: number) => (
      <Panel key={title}>
        <PanelHeader title={title} />
        <SkeletonRows rows={rows} />
      </Panel>
    )
    return wrap(
      <>
        {backButton}
        <Panel>
          <SkeletonRows />
        </Panel>
        <div className="flex flex-col gap-3 lg:grid lg:grid-cols-12 lg:items-start">
          <div className="flex flex-col gap-3 lg:col-span-8">{[skel('EQUITY'), skel('DRAWDOWN', 2), skel('STATS BY WINDOW')]}</div>
          <div className="flex flex-col gap-3 lg:col-span-4">{[skel('LATEST VS THRESHOLDS', 2), skel('SAVE TO CATALOGUE', 2), skel('SENSITIVITY')]}</div>
        </div>
      </>,
    )
  }
  if (!ev || !rule) {
    const err = (runId ? failed(run) : null) ?? (catalogue.error || catalogue.offline ? failed(catalogue) : null) ?? (adhoc ? failed(evaluation) : null)
    return wrap(
      <>
        {backButton}
        <Panel>
          {err ?? <EmptyBlock label="rule not found: it is not in the catalogue and the search run it came from is not known" action={{ label: 'SEARCH', onClick: () => navigate('/lab/search') }} />}
        </Panel>
      </>,
    )
  }

  const bench = benchmarkLabel(rule)
  const dataTo = (ev.holdout ?? ev.walkForward ?? ev.inSample).to
  const holdoutFrom = ev.holdout?.from ?? run.data?.result?.dataRange.holdoutFrom ?? null
  const equity = evaluation.data?.equity ?? null
  const maxDd = equity ? computeDrawdown(equity.map((p) => ({ ts: p.t, value: p.strategy }))).reduce((m, p) => Math.min(m, p.value), 0) : 0
  const sens = fresh?.sensitivity ?? (evaluating ? null : (base?.sensitivity ?? null))
  const slip = slippageBps ?? 10
  const live = listed?.live ?? null

  return wrap(
    <>
      {backButton}

      <Panel>
        {isStaleDate(dataTo) && <StaleBanner generatedAt={dateIso(dataTo)} thresholdHours={48} noun="data" />}
        <RuleDrillHeader
          ev={ev}
          metrics={metricDefs}
          sensitivity={sens ?? null}
          savedAt={entry?.savedAt ?? null}
          onRemove={() => setRemoving(true)}
          dsrN={dsrN}
          current={current}
          atSearch={atSearch}
        />
      </Panel>

      <div className="flex flex-col gap-3 lg:grid lg:grid-cols-12 lg:items-start">
        <div className="contents lg:flex lg:flex-col lg:gap-3 lg:col-span-8">
          <Panel className="order-2 lg:order-none">
            <PanelHeader title={`EQUITY VS ${bench}`} />
            <div className="p-2">
              {equity && holdoutFrom ? (
                <RuleEquityChart equity={equity} holdoutFrom={holdoutFrom} savedAt={entry?.savedAt} benchmarkLabel={bench} />
              ) : evaluating ? (
                <SkeletonRows />
              ) : (
                failed(evaluation) ?? <EmptyBlock label="no equity curve: today's evaluation returned none, or the holdout start is unknown" />
              )}
            </div>
            <RuleEquityGuide benchmarkLabel={bench} saved={entry?.savedAt != null} className="px-3 pb-2" />
            <LabFooter dataTo={dataTo} slippageBps={slip} className="px-3 pb-2" />
          </Panel>

          <Panel className="order-3 lg:order-none">
            <PanelHeader title="DRAWDOWN">{equity && <span className="text-xs tabular text-red-text">MAX DRAWDOWN {fmtSigned(maxDd, 1)}%</span>}</PanelHeader>
            <div className="p-2">
              {equity ? (
                <DrawdownChart equity={equity.map((p) => ({ ts: p.t, value: p.strategy }))} />
              ) : evaluating ? (
                <SkeletonRows rows={2} />
              ) : (
                failed(evaluation) ?? <EmptyBlock label="no equity curve, so no drawdown to draw" />
              )}
            </div>
            <DrawdownGuide className="px-3 pb-2" />
          </Panel>

          <Panel className="order-4 lg:order-none">
            <PanelHeader title="STATS BY WINDOW" />
            <HowToRead terms={WINDOW_TERMS} className={GUIDE}>
              One column per stretch of history, the same statistics in each. Compare walk-forward with holdout: a rule that carries forward shows a similar Sharpe in both, on enough
              trades to mean something. In-sample is the flattering view and is not evidence.
            </HowToRead>
            <WindowStatsTable
              ev={ev}
              live={live}
              catalogued={entry != null}
              benchmarkLabel={bench}
              dsrN={dsrN}
              wfSub={current ? 'NOW' : atSearch?.label}
              atSearch={current ? atSearch : null}
            />
            <LabFooter dataTo={dataTo} slippageBps={slip} className="px-3 py-2" />
          </Panel>
        </div>

        <div className="contents lg:flex lg:flex-col lg:gap-3 lg:col-span-4">
          <Panel className="order-1 lg:order-none">
            <PanelHeader title="LATEST VS THRESHOLDS">
              <span className="text-xs tabular text-text-secondary">
                AS OF <DataTo date={ev.latest.date} />
              </span>
            </PanelHeader>
            {isStaleDate(ev.latest.date) && <StaleBanner generatedAt={dateIso(ev.latest.date)} thresholdHours={48} noun="latest values" />}
            <HowToRead className={GUIDE}>
              Each condition of the rule with the metric's value on the latest daily bar, the cut-off, and whether it is met. The rule is firing only when every row is met.
            </HowToRead>
            <LatestValuesRow ev={ev} metrics={metricDefs} />
          </Panel>

          <div ref={saveRef} className="order-6 lg:order-none">
            <Panel>
              <PanelHeader title="SAVE TO CATALOGUE" />
              <HowToRead className={GUIDE}>
                Saving keeps the rule with today's numbers and starts its live record from the save date, so later results cannot have shaped the choice. The verdict does not block
                saving. The Lab's own bar is ROBUST; a CANDIDATE is worth a note saying why you track it anyway.
              </HowToRead>
              {catalogue.loading && !catalogue.data ? (
                <SkeletonRows rows={2} />
              ) : adhocCatalogueId ? (
                <div className="p-3">
                  <InCatalogueLink id={adhocCatalogueId} />
                </div>
              ) : (
                <SaveToCatalogueForm
                  ref={nameRef}
                  rule={rule}
                  runId={runId}
                  defaultName={defaultName}
                  entry={entry}
                  onSaved={(e) => {
                    setSavedEntry(e)
                    catalogue.refetch()
                  }}
                />
              )}
            </Panel>
          </div>

          <Panel className="order-5 lg:order-none">
            <PanelHeader title="SENSITIVITY">
              {sens ? (
                <span className="text-xs tabular">
                  STABILITY <StabValue stability={sens.stability} />
                </span>
              ) : null}
            </PanelHeader>
            <HowToRead terms={SENSITIVITY_TERMS} className={GUIDE}>
              Does the result survive small changes? Each cell is the rule with one cut-off or one window nudged. A rule that only works at its exact settings is likely fitted to
              noise: stability under {MIN_STABILITY} fails the save bar.
            </HowToRead>
            {sens ? (
              <SensitivityGrid rule={rule} sensitivity={sens} metrics={metricDefs} />
            ) : evaluating ? (
              <>
                <SkeletonRows />
                <p className="px-3 pb-2 text-xs text-text-secondary">
                  <span className="pulse-label">computing sensitivity…</span>
                </p>
              </>
            ) : (
              failed(evaluation) ?? <EmptyBlock label="no sensitivity grid: today's evaluation did not return one" />
            )}
          </Panel>
        </div>
      </div>

      {removing && entry && (
        <RemoveRuleDialog entry={entry} onCancel={() => setRemoving(false)} onRemoved={() => navigate('/lab/catalogue')} />
      )}
    </>,
  )
}
