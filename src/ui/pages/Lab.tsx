import { useMemo, useState } from 'react'
import { Badge, Button, ConfirmDialog, EmptyBlock, ErrorBlock, OfflineBlock, Segmented, SkeletonRows, StatusDot, type DotStatus } from '../components'
import { RuleCard } from '../components/lab/RuleCard'
import { fmtNum, fmtPctPre, fmtShare, signTone } from '../components/lab/format'
import { api, ApiError, NetworkError, useApi } from '../lib/api'
import {
  LAB_GROUPS,
  type LabCatalogueEntry,
  type LabDirection,
  type LabGroup,
  type LabPulse,
  type LabRuleReport,
  type LabSearchOptions,
  type LabSearchResult,
} from '../../shared/lab'

// /lab — open-data rule research (SPEC.md "Lab"). Left rail: run form and
// data coverage. Main column: the current run's rules, the saved catalogue
// re-checked on today's data, and recent runs. The search runs server-side
// in a few seconds; there is no streaming, only a pulse label.

type FeatureInfo = {
  id: string
  label: string
  group: LabGroup
  units: string
  source: string
  description: string
  lagDays: number
  coverage: { from: string; to: string; rows: number } | null
  syncError: string | null
}
type FeaturesPayload = { bases: FeatureInfo[] }
type RunListRow = { id: string; createdAt: string; request: LabSearchOptions; summary: { trials?: number; range?: LabSearchResult['range']; top?: string[] } }
type SearchResponse = LabSearchResult & { runId: string | null }

const DAY_MS = 86_400_000

function coverageStatus(b: FeatureInfo): DotStatus {
  if (!b.coverage) return b.syncError ? 'down' : 'unknown'
  const age = Date.now() - Date.parse(`${b.coverage.to}T00:00:00Z`)
  if (b.syncError || age > 3 * DAY_MS) return 'degraded'
  return 'ok'
}

function errorText(err: unknown): string {
  if (err instanceof NetworkError) return 'API unreachable'
  if (err instanceof ApiError && err.status === 503) return 'database not configured (DATABASE_URL)'
  return err instanceof Error ? err.message : String(err)
}

function PulseStrip({ pulse }: { pulse: LabPulse }) {
  const total = pulse.long.total + pulse.short.total
  if (total === 0) return <span className="text-[10px] text-text-secondary">NO SAVED RULES</span>
  const tone = pulse.lean > 0.1 ? 'green' : pulse.lean < -0.1 ? 'red' : 'gray'
  return (
    <div className="flex items-center gap-2 text-[10px] tabular" title="Saved rules firing on today's data">
      <span className="text-green">LONG {pulse.long.active}/{pulse.long.total}</span>
      <span className="text-red-text">SHORT {pulse.short.active}/{pulse.short.total}</span>
      <Badge tone={tone}>LEAN {pulse.lean >= 0 ? '+' : ''}{pulse.lean.toFixed(2)}</Badge>
    </div>
  )
}

export function Lab() {
  const features = useApi<FeaturesPayload>('/lab/features')
  const catalogue = useApi<{ entries: LabCatalogueEntry[]; pulse: LabPulse }>('/lab/catalogue')
  const runs = useApi<RunListRow[]>('/lab/runs')

  const [direction, setDirection] = useState<LabDirection>('long')
  const [effort, setEffort] = useState<LabSearchOptions['effort']>('standard')
  const [groups, setGroups] = useState<Set<LabGroup>>(() => new Set(LAB_GROUPS))
  const [from, setFrom] = useState('2015-01-01')
  const [costBps, setCostBps] = useState(10)
  const [running, setRunning] = useState(false)
  const [runError, setRunError] = useState<string | null>(null)
  const [result, setResult] = useState<SearchResponse | null>(null)
  const [saving, setSaving] = useState<string | null>(null)
  const [savedTexts, setSavedTexts] = useState<Set<string>>(new Set())
  const [deleting, setDeleting] = useState<LabCatalogueEntry | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const catalogued = useMemo(() => new Set(catalogue.data?.entries.map((e) => e.report.text) ?? []), [catalogue.data])
  const isSaved = (text: string) => savedTexts.has(text) || catalogued.has(text)
  const bases = features.data?.bases ?? []
  const selectedBases = useMemo(() => bases.filter((b) => groups.has(b.group) && b.coverage).map((b) => b.id), [bases, groups])

  function toggleGroup(g: LabGroup) {
    setGroups((cur) => {
      const next = new Set(cur)
      if (next.has(g)) next.delete(g)
      else next.add(g)
      return next
    })
  }

  async function run() {
    setRunning(true)
    setRunError(null)
    try {
      const res = await api.post<SearchResponse>('/lab/search', { direction, effort, from, costBps, bases: selectedBases })
      setResult(res)
      runs.refetch()
    } catch (err) {
      setRunError(errorText(err))
    } finally {
      setRunning(false)
    }
  }

  async function openRun(id: string) {
    setRunError(null)
    try {
      const row = await api.get<{ id: string; result: LabSearchResult }>(`/lab/runs/${id}`)
      setResult({ ...row.result, runId: row.id })
    } catch (err) {
      setRunError(errorText(err))
    }
  }

  async function save(r: LabRuleReport) {
    setSaving(r.text)
    try {
      await api.post('/lab/catalogue', { report: r })
      setSavedTexts((s) => new Set(s).add(r.text))
      catalogue.refetch()
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) setSavedTexts((s) => new Set(s).add(r.text))
      else setRunError(errorText(err))
    } finally {
      setSaving(null)
    }
  }

  async function doDelete() {
    if (!deleting) return
    try {
      await api.del(`/lab/catalogue/${deleting.id}`)
      setDeleting(null)
      setDeleteError(null)
      catalogue.refetch()
    } catch (err) {
      setDeleteError(errorText(err))
    }
  }

  const noDb = features.error?.includes('database not configured')

  return (
    <div className="max-w-[1440px] mx-auto p-3 md:p-[var(--gutter)] flex flex-col gap-3">
      <div className="panel">
        <div className="panel-header">
          <span className="panel-title">LAB</span>
          {catalogue.data && <PulseStrip pulse={catalogue.data.pulse} />}
        </div>
        <div className="panel-body p-3 text-[11px] text-text-secondary leading-relaxed">
          Searches free on-chain, sentiment, liquidity and derivatives history for one- and two-condition BTC rules. Thresholds refit walk-forward across five
          folds; the last 20% of history is a holdout the search never reads. Judge a rule on the holdout column, not in-sample.
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-[320px_minmax(0,1fr)] items-start">
        <div className="flex flex-col gap-3 lg:sticky lg:top-[52px]">
          <div className="panel">
            <div className="panel-header">
              <span className="panel-title">RUN</span>
            </div>
            <div className="panel-body p-3 flex flex-col gap-3 text-[10px]">
              <label className="flex flex-col gap-1">
                <span className="text-text-secondary">DIRECTION</span>
                <Segmented
                  label="direction"
                  value={direction}
                  onChange={setDirection}
                  options={[
                    { value: 'long', label: 'LONG', tone: 'green' },
                    { value: 'short', label: 'SHORT', tone: 'red' },
                  ]}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-text-secondary">EFFORT</span>
                <Segmented
                  label="search effort"
                  value={effort}
                  onChange={setEffort}
                  options={[
                    { value: 'quick', label: 'QUICK', title: 'beam 12' },
                    { value: 'standard', label: 'STANDARD', title: 'beam 30' },
                    { value: 'deep', label: 'DEEP', title: 'beam 60' },
                  ]}
                />
              </label>
              <fieldset className="flex flex-col gap-1">
                <legend className="text-text-secondary mb-1">DATA GROUPS · {selectedBases.length} SERIES</legend>
                <div className="flex flex-wrap gap-1.5">
                  {LAB_GROUPS.map((g) => (
                    <button
                      key={g}
                      type="button"
                      aria-pressed={groups.has(g)}
                      onClick={() => toggleGroup(g)}
                      className={`h-[var(--control-sm)] px-2 uppercase tracking-wider border border-border ${groups.has(g) ? 'text-text-primary bg-elevated' : 'text-text-secondary'}`}
                    >
                      {g}
                    </button>
                  ))}
                </div>
              </fieldset>
              <div className="grid grid-cols-2 gap-2">
                <label className="flex flex-col gap-1">
                  <span className="text-text-secondary">FROM</span>
                  <input type="date" value={from} min="2011-01-01" onChange={(e) => setFrom(e.target.value)} className="w-full" />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-text-secondary">COST BPS / CHANGE</span>
                  <input type="number" min={0} max={100} value={costBps} onChange={(e) => setCostBps(Number(e.target.value))} className="w-full" />
                </label>
              </div>
              <Button tier="neutral" onClick={run} disabled={running || selectedBases.length === 0}>
                {running ? <span className="pulse-label">SEARCHING…</span> : 'RUN SEARCH'}
              </Button>
              {selectedBases.length === 0 && features.data && <span className="text-amber">no selected group has data yet — the daily collector fills it</span>}
            </div>
          </div>

          <div className="panel">
            <div className="panel-header">
              <span className="panel-title">DATA</span>
              <span className="text-[10px] text-text-secondary">FREE SOURCES · DAILY</span>
            </div>
            <div className="panel-body px-3 py-1">
              {features.loading && !features.data && (
                <table className="w-full">
                  <tbody>
                    <SkeletonRows rows={6} colSpan={2} />
                  </tbody>
                </table>
              )}
              {features.offline && <OfflineBlock onRetry={features.refetch} />}
              {noDb && <OfflineBlock title="DATABASE NOT CONFIGURED" message="set DATABASE_URL and apply db/migrations/003_lab.sql" onRetry={features.refetch} />}
              {features.error && !noDb && <ErrorBlock message={features.error} onRetry={features.refetch} />}
              <ul className="flex flex-col">
                {bases.map((b) => (
                  <li key={b.id} className="flex items-start gap-2 py-1 border-t border-border-subtle first:border-t-0 text-[10px]" title={`${b.description} · lag ${b.lagDays}d · ${b.id}`}>
                    <StatusDot status={coverageStatus(b)} className="mt-1" />
                    <div className="flex flex-col min-w-0 flex-1">
                      <span className="text-text-primary">
                        {b.label} <span className="text-text-secondary">· {b.group}</span>
                      </span>
                      {b.syncError && <span className="text-red-text truncate">{b.syncError}</span>}
                    </div>
                    <span className="text-text-secondary tabular whitespace-nowrap">{b.coverage ? `${b.coverage.from.slice(0, 4)}→${b.coverage.to.slice(5)}` : 'NO DATA'}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-3 min-w-0">
          <div className="panel">
            <div className="panel-header">
              <span className="panel-title">RESULTS</span>
              {result && (
                <span className="text-[10px] text-text-secondary tabular">
                  {result.request.direction.toUpperCase()} · {result.trials.toLocaleString()} VARIANTS · {result.features} FEATURES · {(result.elapsedMs / 1000).toFixed(1)}S
                </span>
              )}
            </div>
            <div className="panel-body p-3 flex flex-col gap-3">
              {runError && <ErrorBlock message={runError} />}
              {!result && !running && <EmptyBlock label="run a search, or open a recent run" />}
              {running && !result && <span className="pulse-label text-[11px] text-text-secondary py-6 text-center">SEARCHING…</span>}
              {result && (
                <>
                  <div className="text-[10px] text-text-secondary tabular">
                    TRAIN {result.range.from} → {result.range.trainEnd} · HOLDOUT {result.range.trainEnd} → {result.range.to}
                    {result.warnings.map((w) => (
                      <div key={w} className="text-amber">
                        {w}
                      </div>
                    ))}
                  </div>
                  {result.results.length === 0 && <EmptyBlock label="no rule met the exposure and trade-count limits" />}
                  <div className="grid gap-3 xl:grid-cols-2">
                    {result.results.map((r) => (
                      <RuleCard
                        key={r.text}
                        report={r}
                        splitAt={result.range.trainEnd}
                        actions={
                          <Button tier="ghost" disabled={saving === r.text || isSaved(r.text)} onClick={() => save(r)}>
                            {isSaved(r.text) ? 'SAVED' : saving === r.text ? <span className="pulse-label">SAVING…</span> : 'SAVE TO CATALOGUE'}
                          </Button>
                        }
                      />
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>

          <div className="panel">
            <div className="panel-header">
              <span className="panel-title">CATALOGUE</span>
              {catalogue.data && <span className="text-[10px] text-text-secondary">{catalogue.data.entries.length} SAVED · RE-CHECKED ON TODAY'S DATA</span>}
            </div>
            <div className="panel-body p-3 flex flex-col gap-3">
              {catalogue.loading && !catalogue.data && (
                <table className="w-full">
                  <tbody>
                    <SkeletonRows rows={2} colSpan={1} />
                  </tbody>
                </table>
              )}
              {catalogue.error && !noDb && <ErrorBlock message={catalogue.error} onRetry={catalogue.refetch} />}
              {catalogue.data?.entries.length === 0 && <EmptyBlock label="save rules worth tracking; their live record starts the day you save them" />}
              <div className="grid gap-3 xl:grid-cols-2">
                {catalogue.data?.entries.map((e) => (
                  <RuleCard
                    key={e.id}
                    report={e.report}
                    firingNow={e.live?.firingNow ?? e.report.firingNow}
                    asOf={e.live?.asOf ?? e.report.asOf}
                    footer={
                      <div className="text-[10px] tabular border-t border-border-subtle pt-2 flex flex-wrap gap-x-4 gap-y-1">
                        <span className="text-text-secondary">SAVED {e.createdAt.slice(0, 10)}{e.note ? ` · ${e.note}` : ''}</span>
                        {e.error && <span className="text-red-text">{e.error}</span>}
                        {e.live?.sinceSaved ? (
                          <span title="Only days after the save: data the search never saw">
                            <span className="text-text-secondary">SINCE SAVED </span>
                            <span className={signTone(e.live.sinceSaved.totalReturnPct)}>{fmtPctPre(e.live.sinceSaved.totalReturnPct)}</span>
                            <span className="text-text-secondary"> vs B&H </span>
                            <span className={signTone(e.live.sinceSaved.benchmark.totalReturnPct)}>{fmtPctPre(e.live.sinceSaved.benchmark.totalReturnPct)}</span>
                            <span className="text-text-secondary"> · {e.live.sinceSaved.days}D · IN MKT {fmtShare(e.live.sinceSaved.exposure)} · SHARPE {fmtNum(e.live.sinceSaved.sharpe)}</span>
                          </span>
                        ) : (
                          e.live && <span className="text-text-secondary">LIVE RECORD STARTS TOMORROW</span>
                        )}
                      </div>
                    }
                    actions={
                      <Button tier="danger" onClick={() => setDeleting(e)}>
                        DELETE
                      </Button>
                    }
                  />
                ))}
              </div>
            </div>
          </div>

          <div className="panel">
            <div className="panel-header">
              <span className="panel-title">RECENT RUNS</span>
            </div>
            <div className="panel-body px-3 py-1">
              {runs.data?.length === 0 && <EmptyBlock label="no runs yet" />}
              {runs.error && !noDb && <ErrorBlock message={runs.error} onRetry={runs.refetch} />}
              <ul className="flex flex-col">
                {runs.data?.map((r) => (
                  <li key={r.id} className="border-t border-border-subtle first:border-t-0">
                    <button type="button" onClick={() => openRun(r.id)} className="w-full text-left py-1.5 flex flex-col gap-0.5 hover:bg-hover px-1">
                      <span className="text-[10px] text-text-secondary tabular">
                        {new Date(r.createdAt).toLocaleString()} · {r.request.direction?.toUpperCase()} · {r.request.effort?.toUpperCase()} · {(r.summary.trials ?? 0).toLocaleString()} VARIANTS
                        {result?.runId === r.id && <span className="text-text-primary"> · OPEN</span>}
                      </span>
                      {r.summary.top?.[0] && <span className="text-[11px] text-text-primary truncate">{r.summary.top[0]}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </div>

      {deleting && (
        <ConfirmDialog
          title="DELETE RULE"
          body={`Remove "${deleting.report.text}" from the catalogue? Its live record since ${deleting.createdAt.slice(0, 10)} goes with it.`}
          confirmLabel="DELETE"
          onConfirm={doDelete}
          onCancel={() => {
            setDeleting(null)
            setDeleteError(null)
          }}
          error={deleteError}
        />
      )}
    </div>
  )
}
