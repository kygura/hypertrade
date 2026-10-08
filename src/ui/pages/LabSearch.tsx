import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router'
import { EmptyBlock, ErrorBlock, OfflineBlock, Panel, PanelHeader, SkeletonRows, StaleBanner } from '../components'
import { LabWarnings } from '../components/LabWarnings'
import { useLabData } from '../components/lab/LabData'
import { LabSearchForm, SearchSummaryBar } from '../components/lab/LabSearchForm'
import { ResultsHeader } from '../components/lab/ResultsHeader'
import { ResultsFilters } from '../components/lab/ResultsFilters'
import { SignalCard } from '../components/lab/SignalCard'
import { FeatureImportanceList } from '../components/lab/FeatureImportanceList'
import { LabFooter } from '../components/lab/common'
import { searchStore, useSearchStore } from '../components/lab/searchStore'
import { dateIso, DEFAULT_FILTERS, filterRules, readLocal, validateForm, writeLocal, type Direction, type ResultsFilterState, type RuleEvaluation } from '../lib/lab'

// SEARCH tab — DESIGN.md §10.9. Form (sticky at lg) + the results of the
// current/last run in this browser; /lab/runs/:runId loads a stored run's
// config and results into the same layout.

const FILTERS_KEY = 'lab.filters'

export function LabSearch() {
  const { runId } = useParams<{ runId?: string }>()
  const location = useLocation()
  const navigate = useNavigate()
  const store = useSearchStore()
  const { metrics, catalogue } = useLabData()
  const [filters, setFiltersState] = useState<ResultsFilterState>(() => readLocal(FILTERS_KEY, DEFAULT_FILTERS))
  const resultsRef = useRef<HTMLDivElement>(null)
  const seenSeq = useRef(store.landSeq)
  const errors = validateForm(store.form)
  const savedIds = useMemo(() => new Set((catalogue.data ?? []).map((e) => e.id)), [catalogue.data])

  const setFilters = (f: ResultsFilterState) => {
    setFiltersState(f)
    writeLocal(FILTERS_KEY, f)
  }

  // Route → which run is shown.
  useEffect(() => {
    const s = searchStore.get()
    if (runId) {
      if (s.landed?.runId !== runId && !s.busy) void searchStore.loadRun(runId)
    } else if (!s.landed && !s.busy && !s.runLoad) {
      const last = searchStore.lastRunId()
      if (last) void searchStore.loadRun(last, true)
    }
  }, [runId])

  // CATALOGUE gaps → SEARCH with asset/direction prefilled.
  useEffect(() => {
    const prefill = (location.state as { prefill?: { asset: string; direction: Direction } } | null)?.prefill
    if (!prefill) return
    searchStore.setForm({ asset: prefill.asset.toUpperCase(), direction: prefill.direction })
    searchStore.setCollapsed(false)
    navigate(location.pathname, { replace: true, state: null })
  }, [location.state, location.pathname, navigate])

  // Results scroll into view once per landed search (mobile single column), never on refetch.
  useEffect(() => {
    if (store.landSeq === seenSeq.current) return
    seenSeq.current = store.landSeq
    if (typeof window !== 'undefined' && window.matchMedia?.('(max-width: 1023px)').matches) {
      resultsRef.current?.scrollIntoView({ block: 'start' })
    }
  }, [store.landSeq])

  const run = () => {
    if (runId) navigate('/lab/search')
    void searchStore.run()
  }

  const openRule = (ev: RuleEvaluation, save: boolean) => {
    searchStore.select(ev.id)
    const q = new URLSearchParams({ from: 'results' })
    if (store.landed?.runId) q.set('run', store.landed.runId)
    navigate(`/lab/rules/${encodeURIComponent(ev.id)}?${q.toString()}`, { state: save ? { focusSave: true } : undefined })
  }

  if (metrics.offline && !metrics.data) return <OfflineBlock onRetry={metrics.refetch} />

  const landed = store.landed
  const result = landed?.result ?? null
  const busy = store.busy != null
  const filtered = result ? filterRules(result.rules, filters) : []
  const rankOf = new Map(result?.rules.map((r, i) => [r.id, i + 1]) ?? [])
  const metricDefs = metrics.data ?? []

  let body: React.ReactNode
  if (store.runLoad?.loading && !landed) {
    body = (
      <Panel>
        <PanelHeader title="RESULTS" />
        <SkeletonRows />
      </Panel>
    )
  } else if (store.runLoad && !store.runLoad.loading) {
    body = (
      <Panel>
        <PanelHeader title="RESULTS" />
        {store.runLoad.offline ? (
          <OfflineBlock onRetry={() => void searchStore.loadRun(store.runLoad!.id)} />
        ) : (
          <ErrorBlock message={store.runLoad.error ?? 'run failed to load'} onRetry={() => void searchStore.loadRun(store.runLoad!.id)} />
        )}
      </Panel>
    )
  } else if (!landed) {
    body = (
      <Panel>
        <PanelHeader title="RESULTS" />
        <EmptyBlock label="no results yet — run a search" />
      </Panel>
    )
  } else if (landed.error || !result) {
    body = (
      <Panel>
        <PanelHeader title="RESULTS" />
        <div className="px-3 py-2 text-xs text-text-secondary tabular" title={landed.runId ?? undefined}>
          RUN {landed.runId?.slice(0, 4) ?? '—'} · FAILED — its config is loaded in the form for correction
        </div>
        <ErrorBlock message={landed.error ?? 'run has no result'} />
      </Panel>
    )
  } else {
    body = (
      <>
        <Panel>
          <PanelHeader title="RESULTS" />
          <StaleBanner generatedAt={dateIso(result.dataRange.to)} thresholdHours={48} noun="data" />
          <ResultsHeader runId={landed.runId} createdAt={landed.createdAt} result={result} />
          <LabWarnings warnings={result.warnings} />
          <ResultsFilters value={filters} onChange={setFilters} shown={filtered.length} total={result.rules.length} />
          {result.rules.length === 0 ? (
            <EmptyBlock label="no rule survived — try more metrics, a longer horizon or a lower min support" />
          ) : filtered.length === 0 ? (
            <EmptyBlock label="no rule matches these filters" action={{ label: 'CLEAR FILTERS', onClick: () => setFilters({ ...DEFAULT_FILTERS, window: filters.window }) }} />
          ) : (
            <ol aria-label="rules">
              {filtered.map((ev) => (
                <li key={ev.id}>
                  <SignalCard
                    rank={rankOf.get(ev.id) ?? 0}
                    ev={ev}
                    metrics={metricDefs}
                    window={filters.window}
                    saved={savedIds.has(ev.id)}
                    selected={store.selectedRuleId === ev.id}
                    onOpen={() => openRule(ev, false)}
                    onSave={() => openRule(ev, true)}
                  />
                </li>
              ))}
            </ol>
          )}
          <LabFooter dataTo={result.dataRange.to} slippageBps={result.config.slippageBps} className="px-3 py-2" />
        </Panel>
        <Panel>
          <PanelHeader title="FEATURE IMPORTANCE" />
          <FeatureImportanceList items={result.featureImportance} metrics={metricDefs} />
        </Panel>
      </>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {store.collapsed && landed && <SearchSummaryBar form={store.form} onEdit={() => searchStore.setCollapsed(false)} />}
      <div className="grid gap-3 lg:grid-cols-12 items-start">
        <div className={`lg:col-span-4 lg:sticky lg:top-[92px] ${store.collapsed && landed ? 'hidden lg:block' : ''}`}>
          <Panel>
            <PanelHeader title="SEARCH" />
            <LabSearchForm
              form={store.form}
              setForm={(patch) => {
                searchStore.setForm(patch)
                searchStore.clearError()
              }}
              errors={errors}
              metrics={metrics}
              store={store}
              onRun={run}
              onStop={() => searchStore.stopWaiting()}
              msPerTrial={searchStore.msPerTrial()}
            />
          </Panel>
        </div>
        <div ref={resultsRef} className={`lg:col-span-8 flex flex-col gap-3 scroll-mt-[136px] transition-opacity duration-200 ${busy && result ? 'opacity-70' : ''}`}>
          {body}
        </div>
      </div>
      <p role="status" aria-live="polite" className="sr-only">
        {store.announce}
      </p>
    </div>
  )
}
