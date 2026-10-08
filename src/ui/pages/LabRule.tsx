import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router'
import { Button, EmptyBlock, ErrorBlock, OfflineBlock, Panel, PanelHeader, SkeletonRows, StaleBanner } from '../components'
import { RuleEquityChart } from '../components/charts/RuleEquityChart'
import { DrawdownChart } from '../components/branches/DrawdownChart'
import { computeDrawdown } from '../components/branches/format'
import { RuleDrillHeader } from '../components/lab/RuleDrillHeader'
import { WindowStatsTable } from '../components/lab/WindowStatsTable'
import { SensitivityGrid } from '../components/lab/SensitivityGrid'
import { LatestValuesRow } from '../components/lab/LatestValuesRow'
import { SaveToCatalogueForm } from '../components/lab/SaveToCatalogueForm'
import { RemoveRuleDialog } from '../components/lab/RemoveRuleDialog'
import { DataTo, LabFooter } from '../components/lab/common'
import {
  benchmarkLabel,
  dateIso,
  defaultRuleName,
  drillEvaluation,
  effectiveTrials,
  fmtSigned,
  isStaleDate,
  lab,
  stabWord,
  useLab,
  type CatalogueEntry,
  type CatalogueListEntry,
  type LabState,
} from '../lib/lab'

// /lab/rules/:id — rule drill (DESIGN.md §10.9). Full-view route like the
// markets drill: linkable from MCP/CLI output, back-button friendly.
// Resolution: ?run=<runId> → lab_get_run and that run's rule with this id;
// else the catalogue entry with this id; else `rule not found`. Then
// lab_evaluate_rule (with equity) and lab_sensitivity refresh the numbers in
// parallel, each in its own panel so one failing never blanks the other.

const BACK: Record<string, { label: string; to: string }> = {
  results: { label: '← RESULTS', to: '/lab/search' },
  catalogue: { label: '← CATALOGUE', to: '/lab/catalogue' },
  pulse: { label: '← PULSE', to: '/lab/pulse' },
}

function failed<T>(s: LabState<T>): ReactNode | null {
  if (s.offline && !s.data) return <OfflineBlock onRetry={s.refetch} />
  if (s.error && !s.data) return <ErrorBlock message={s.error} onRetry={s.refetch} />
  return null
}

export function LabRule() {
  const { id = '' } = useParams<{ id: string }>()
  const [params] = useSearchParams()
  const runId = params.get('run')
  const back = BACK[params.get('from') ?? ''] ?? BACK.results!
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
  const rule = base?.rule ?? null
  const ruleKey = rule ? JSON.stringify(rule) : null
  const slippageBps = run.data?.config.slippageBps
  const windows = run.data?.config.windows

  const runSettled = !runId || run.data != null || run.error != null || run.offline
  const catSettled = catalogue.data != null || catalogue.error != null || catalogue.offline
  const resolving = !base && (!runSettled || !catSettled)

  const evaluation = useLab(rule ? () => lab.evaluate({ rule, includeEquity: true, ...(slippageBps != null ? { slippageBps } : {}) }) : null, [ruleKey])
  const sensitivity = useLab(rule ? () => lab.sensitivity({ rule, ...(windows ? { windows } : {}), ...(slippageBps != null ? { slippageBps } : {}) }) : null, [ruleKey])

  // The rank key, its folds, the deflated Sharpe and the verdict stay the
  // run's / the save-time values: lab_evaluate_rule refits an explicit rule
  // (N = 1, so its DSR is not deflated for the search that found it).
  const ev = drillEvaluation(evaluation.data, base)
  const fromSearch = base?.walkForward != null
  const trialsN = fromSearch ? effectiveTrials(run.data?.result) : ev?.walkForward ? 1 : null
  const metricDefs = metrics.data ?? []
  const defaultName = useMemo(() => (rule ? defaultRuleName(rule, metricDefs) : ''), [ruleKey, metrics.data]) // eslint-disable-line react-hooks/exhaustive-deps

  // Arriving from a card's SAVE: the save form is pre-focused.
  useEffect(() => {
    if (!focusSave || !rule || entry) return
    nameRef.current?.focus()
    saveRef.current?.scrollIntoView({ block: 'center' })
  }, [focusSave, ruleKey, entry == null]) // eslint-disable-line react-hooks/exhaustive-deps

  const backButton = (
    <Button tier="ghost" onClick={() => navigate(back.to)} className="self-start">
      {back.label}
    </Button>
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
    const err = (runId ? failed(run) : null) ?? (catalogue.error || catalogue.offline ? failed(catalogue) : null)
    return wrap(
      <>
        {backButton}
        <Panel>
          {err ?? <EmptyBlock label="rule not found — it was never saved and its run is unknown" action={{ label: 'SEARCH', onClick: () => navigate('/lab/search') }} />}
        </Panel>
      </>,
    )
  }

  const bench = benchmarkLabel(rule)
  const dataTo = (ev.holdout ?? ev.walkForward ?? ev.inSample).to
  const holdoutFrom = ev.holdout?.from ?? run.data?.result?.dataRange.holdoutFrom ?? null
  const equity = evaluation.data?.equity ?? null
  const maxDd = equity ? computeDrawdown(equity.map((p) => ({ ts: p.t, value: p.strategy }))).reduce((m, p) => Math.min(m, p.value), 0) : 0
  const sens = sensitivity.data
  const stab = sens ? stabWord(sens.stability) : null
  const slip = slippageBps ?? 10
  const live = listed?.live ?? null

  return wrap(
    <>
      {backButton}

      <Panel>
        {isStaleDate(dataTo) && <StaleBanner generatedAt={dateIso(dataTo)} thresholdHours={48} noun="data" />}
        <RuleDrillHeader ev={ev} metrics={metricDefs} sensitivity={sens} savedAt={entry?.savedAt ?? null} onRemove={() => setRemoving(true)} trialsN={trialsN} />
      </Panel>

      <div className="flex flex-col gap-3 lg:grid lg:grid-cols-12 lg:items-start">
        <div className="contents lg:flex lg:flex-col lg:gap-3 lg:col-span-8">
          <Panel className="order-2 lg:order-none">
            <PanelHeader title={`EQUITY VS ${bench}`} />
            <div className="p-2">
              {equity && holdoutFrom ? (
                <RuleEquityChart equity={equity} holdoutFrom={holdoutFrom} savedAt={entry?.savedAt} benchmarkLabel={bench} />
              ) : evaluation.loading ? (
                <SkeletonRows />
              ) : (
                failed(evaluation) ?? <EmptyBlock label="no equity curve" />
              )}
            </div>
            <LabFooter dataTo={dataTo} slippageBps={slip} className="px-3 pb-2" />
          </Panel>

          <Panel className="order-3 lg:order-none">
            <PanelHeader title="DRAWDOWN">{equity && <span className="text-xs tabular text-red-text">MAX DD {fmtSigned(maxDd, 1)}%</span>}</PanelHeader>
            <div className="p-2">
              {equity ? (
                <DrawdownChart equity={equity.map((p) => ({ ts: p.t, value: p.strategy }))} />
              ) : evaluation.loading ? (
                <SkeletonRows rows={2} />
              ) : (
                failed(evaluation) ?? <EmptyBlock label="no equity curve" />
              )}
            </div>
          </Panel>

          <Panel className="order-4 lg:order-none">
            <PanelHeader title="STATS BY WINDOW" />
            <WindowStatsTable ev={ev} live={live} catalogued={entry != null} benchmarkLabel={bench} trialsN={trialsN} />
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
            <LatestValuesRow ev={ev} metrics={metricDefs} />
          </Panel>

          <div ref={saveRef} className="order-6 lg:order-none">
            <Panel>
              <PanelHeader title="SAVE TO CATALOGUE" />
              {catalogue.loading && !catalogue.data ? (
                <SkeletonRows rows={2} />
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
              {sens && stab ? (
                <span className="text-xs tabular">
                  STABILITY {sens.stability.toFixed(2)} <span className={stab.tone}>{stab.word}</span>
                </span>
              ) : null}
            </PanelHeader>
            {sens ? (
              <SensitivityGrid rule={rule} sensitivity={sens} metrics={metricDefs} />
            ) : sensitivity.loading ? (
              <>
                <SkeletonRows />
                <p className="px-3 pb-2 text-xs text-text-secondary">
                  <span className="pulse-label">computing sensitivity…</span>
                </p>
              </>
            ) : (
              failed(sensitivity) ?? <EmptyBlock label="no sensitivity" />
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
