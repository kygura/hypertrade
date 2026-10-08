import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import {
  AnimatedDigits,
  Button,
  ConfirmDialog,
  EmptyBlock,
  ErrorBlock,
  OfflineBlock,
  Segmented,
  SkeletonRows,
} from '../components'
import { api, ApiError, useApi } from '../lib/api'
import { BranchConfigSchema, isPerp, STABLES } from '../../shared/schemas'
import type { Allocation, BranchConfig, Scenario } from '../../shared/types'
import type { BranchDetail as BranchDetailData, BranchResult } from '../components/branches/types'
import { EquityChart } from '../components/charts/EquityChart'
import { ProjectionAssumptions } from '../components/charts/FanChart'
import { DrawdownChart } from '../components/branches/DrawdownChart'
import { maxDdClass, signClass, sumWeights } from '../components/branches/format'
import { fmtPct, fmtUsd } from '../../shared/format'

// /branches/:id — DESIGN.md §10.4. Editor (left, 4 cols) + results (right,
// 8 cols: equity/fan, drawdown, stats), reordered on mobile so results
// (checked far more often than edited) lead: equity header → chart →
// config → drawdown → stats.

type Dca = NonNullable<BranchConfig['dca']>[number]

type Busy = 'idle' | 'saving' | 'running'

interface FormState {
  name: string
  description: string
  startDate: string
  initialCapitalUsd: number
  allocations: Allocation[]
  rebalance: BranchConfig['rebalance']
  scenario: Scenario | null
  dca: Dca[]
}

const SIDE_OPTIONS: { value: 'long' | 'short'; label: string; short: string }[] = [
  { value: 'long', label: 'LONG', short: 'L' },
  { value: 'short', label: 'SHORT', short: 'S' },
]

const DCA_EVERY_OPTIONS: { value: Dca['every']; label: string; short: string }[] = [
  { value: 'weekly', label: 'WEEKLY', short: 'WK' },
  { value: 'monthly', label: 'MONTHLY', short: 'MO' },
]

const ALLOC_GRID = 'grid grid-cols-[7ch_9ch_auto_8ch_auto] items-center gap-1.5'
const DCA_GRID = 'grid grid-cols-[7ch_10ch_auto_auto] items-center gap-1.5'

const REBALANCE_OPTIONS: { value: BranchConfig['rebalance']; label: string }[] = [
  { value: 'none', label: 'NONE' },
  { value: 'monthly', label: 'MONTHLY' },
  { value: 'weekly', label: 'WEEKLY' },
  { value: 'threshold5pct', label: '5% BAND' },
]

export function BranchDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { data, loading, error, offline, refetch } = useApi<BranchDetailData>(id ? `/branches/${id}` : null)

  const [form, setForm] = useState<FormState | null>(null)
  const [dirty, setDirty] = useState(false)
  const [result, setResult] = useState<BranchResult | null>(null)
  const [busy, setBusy] = useState<Busy>('idle')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [runError, setRunError] = useState<string | null>(null)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [removeProjectionOpen, setRemoveProjectionOpen] = useState(false)

  useEffect(() => {
    if (data && form === null) {
      setForm({
        name: data.name,
        description: data.config.description ?? '',
        startDate: data.config.startDate,
        initialCapitalUsd: data.config.initialCapitalUsd,
        allocations: data.config.allocations,
        rebalance: data.config.rebalance,
        scenario: data.config.scenario ?? null,
        dca: data.config.dca ?? [],
      })
      setResult(data.result)
    }
  }, [data, form])

  if (!id) return null

  function patch(p: Partial<FormState>) {
    setForm((f) => (f ? { ...f, ...p } : f))
    setDirty(true)
  }

  // --- derived config -------------------------------------------------
  const nonStableCoins = form
    ? [...new Set(form.allocations.map((a) => a.coin.toUpperCase()).filter((c) => c && !STABLES.has(c)))]
    : []

  const resolvedScenario: Scenario | null = form?.scenario
    ? {
        horizonDays: form.scenario.horizonDays,
        paths: form.scenario.paths,
        assumptions: nonStableCoins.map(
          (coin) =>
            form.scenario!.assumptions.find((a) => a.coin === coin) ?? { coin, annualReturnPct: 30, annualVolPct: 60 },
        ),
      }
    : null

  const configCandidate: BranchConfig | null = form
    ? {
        description: form.description || undefined,
        startDate: form.startDate,
        initialCapitalUsd: form.initialCapitalUsd,
        // long / 1x are the defaults: omit them so legacy branches save unchanged.
        allocations: form.allocations.map(({ side, leverage, ...a }) => ({
          ...a,
          ...(side === 'short' && { side }),
          ...(leverage !== undefined && leverage !== 1 && { leverage }),
        })),
        rebalance: form.rebalance,
        scenario: resolvedScenario ?? undefined,
        dca: form.dca.length ? form.dca.map((d) => ({ ...d, coin: d.coin.trim() })) : undefined,
      }
    : null

  const weightSum = form ? sumWeights(form.allocations) : 0
  const weightsValid = Math.abs(weightSum - 100) < 0.01
  const parsedConfig = configCandidate ? BranchConfigSchema.safeParse(configCandidate) : null
  const levValid = !form || form.allocations.every((a) => (a.leverage ?? 1) >= 1 && (a.leverage ?? 1) <= 50)
  const dcaValid = !form || form.dca.every((d) => d.coin.trim() !== '' && d.amountUsd > 0)
  const perp = !!form && form.allocations.some(isPerp)
  const perpConflict = perp && !!form?.scenario
  const editorOk = levValid && dcaValid && !perpConflict
  const canSubmit = weightsValid && editorOk && !!parsedConfig?.success && busy === 'idle'

  // --- actions ----------------------------------------------------------
  async function run() {
    setBusy('running')
    setRunError(null)
    try {
      const res = await api.post<BranchResult>(`/branches/${id}/run`)
      setResult(res)
    } catch (err) {
      setRunError(err instanceof ApiError ? err.message : 'simulation failed')
    } finally {
      setBusy('idle')
    }
  }

  async function save() {
    if (!canSubmit || !form || !configCandidate) return
    setBusy('saving')
    setSaveError(null)
    try {
      await api.put(`/branches/${id}`, { name: form.name, config: configCandidate })
      setDirty(false)
      await run()
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : 'save failed')
      setBusy('idle')
    }
  }

  async function doDelete() {
    setDeleteError(null)
    try {
      await api.del(`/branches/${id}`)
      navigate('/branches')
    } catch (err) {
      setDeleteError(err instanceof ApiError ? err.message : 'delete failed')
    }
  }

  // --- allocation editor helpers ----------------------------------------
  function updateAllocation(i: number, p: Partial<Allocation>) {
    if (!form) return
    const allocations = form.allocations.map((a, idx) => (idx === i ? { ...a, ...p } : a))
    patch({ allocations })
  }
  function addAllocation() {
    if (!form) return
    patch({ allocations: [...form.allocations, { coin: '', weightPct: 0 }] })
  }
  function removeAllocation(i: number) {
    if (!form) return
    patch({ allocations: form.allocations.filter((_, idx) => idx !== i) })
  }

  function updateDca(i: number, p: Partial<Dca>) {
    if (!form) return
    patch({ dca: form.dca.map((d, idx) => (idx === i ? { ...d, ...p } : d)) })
  }

  function updateAssumption(coin: string, p: Partial<{ annualReturnPct: number; annualVolPct: number }>) {
    if (!form?.scenario) return
    const rest = form.scenario.assumptions.filter((a) => a.coin !== coin)
    const current = form.scenario.assumptions.find((a) => a.coin === coin) ?? {
      coin,
      annualReturnPct: 30,
      annualVolPct: 60,
    }
    patch({ scenario: { ...form.scenario, assumptions: [...rest, { ...current, ...p }] } })
  }

  return (
    <div className="max-w-[1440px] mx-auto p-3 md:p-[var(--gutter)]">
      {loading && (
        <div className="panel">
          <div className="panel-body">
            <SkeletonRows rows={5} />
          </div>
        </div>
      )}

      {!loading && offline && (
        <div className="panel">
          <div className="panel-body">
            <OfflineBlock onRetry={refetch} />
          </div>
        </div>
      )}

      {!loading && !offline && error && (
        <div className="panel">
          <div className="panel-body">
            <ErrorBlock message={error} onRetry={refetch} />
          </div>
        </div>
      )}

      {!loading && !offline && !error && form && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-3">
          {/* EQUITY */}
          <div className="order-1 lg:order-none lg:col-start-5 lg:col-span-8 lg:row-start-1 panel">
            <div className="panel-header">
              <span className="panel-title">EQUITY VS BENCHMARKS</span>
            </div>
            <div className="panel-body p-3">
              {!result && busy !== 'running' && (
                <EmptyBlock label="not simulated yet — RUN SIMULATION" action={{ label: 'RUN SIMULATION', onClick: run }} />
              )}
              {!result && busy === 'running' && <SkeletonRows rows={4} />}
              {result && (
                <div style={{ opacity: busy === 'running' ? 0.7 : 1 }}>
                  <div className="mb-1">
                    <span className="text-xl tabular">
                      <AnimatedDigits text={fmtUsd(result.stats.finalValue, { decimals: 0 })} />
                    </span>
                  </div>
                  <div className="text-[12px] tabular mb-3">
                    <span className={signClass(result.stats.finalValue / form.initialCapitalUsd - 1)}>
                      {fmtPct(result.stats.finalValue / form.initialCapitalUsd - 1, { decimals: 1, sign: true })}
                    </span>{' '}
                    · CAGR {fmtPct(result.stats.cagrPct / 100, { decimals: 1, sign: true })} · vs BTC{' '}
                    <span className={signClass(result.stats.vsBtcPct)}>
                      {fmtPct(result.stats.vsBtcPct / 100, { decimals: 1, sign: true })}
                    </span>
                  </div>
                  <EquityChart
                    equity={result.equity}
                    btc={result.benchmarks.btc}
                    usdc={result.benchmarks.usdc}
                    projection={result.montecarlo}
                  />
                  {result.montecarlo && resolvedScenario && (
                    <div className="mt-2">
                      <ProjectionAssumptions scenario={resolvedScenario} />
                    </div>
                  )}
                </div>
              )}
              {runError && (
                <div className="mt-2">
                  <ErrorBlock message={runError} onRetry={run} />
                </div>
              )}
            </div>
          </div>

          {/* CONFIG */}
          <div className="order-2 lg:order-none lg:col-start-1 lg:col-span-4 lg:row-start-1 lg:row-span-3 panel">
            <div className="panel-header">
              <span className="flex items-center gap-1.5">
                <span className="panel-title">CONFIG</span>
                {dirty && <span className="inline-block w-1.5 h-1.5 bg-amber" title="unsaved changes" />}
              </span>
            </div>
            <div className="panel-body p-3 flex flex-col gap-3">
              <label className="flex flex-col gap-1">
                <span className="label">NAME</span>
                <input value={form.name} onChange={(e) => patch({ name: e.target.value })} className="w-full" />
              </label>
              <label className="flex flex-col gap-1">
                <span className="label">DESCRIPTION</span>
                <input
                  value={form.description}
                  onChange={(e) => patch({ description: e.target.value })}
                  className="w-full"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="label">START</span>
                <input
                  type="date"
                  value={form.startDate}
                  onChange={(e) => patch({ startDate: e.target.value })}
                  className="w-full"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="label">CAPITAL</span>
                <input
                  type="number"
                  min={0}
                  value={form.initialCapitalUsd}
                  onChange={(e) => patch({ initialCapitalUsd: Number(e.target.value) })}
                  className="w-full"
                />
              </label>

              <div className="flex flex-col gap-1.5 pt-1 border-t border-border-subtle">
                <span className="label">ALLOCATIONS</span>
                <div className="table-scroll">
                  <div className="flex flex-col gap-1 min-w-max">
                    <div className={`${ALLOC_GRID} label`}>
                      <span>COIN</span>
                      <span>WEIGHT</span>
                      <span>SIDE</span>
                      <span>LEV</span>
                    </div>
                    {form.allocations.map((a, i) => {
                      const stable = STABLES.has(a.coin.toUpperCase())
                      const lock = stable ? 'stablecoins are spot only' : undefined
                      return (
                        <div key={i} className={ALLOC_GRID}>
                          <input
                            value={a.coin}
                            onChange={(e) => {
                              const coin = e.target.value.toUpperCase()
                              updateAllocation(
                                i,
                                STABLES.has(coin) ? { coin, side: undefined, leverage: undefined } : { coin },
                              )
                            }}
                            className="w-full"
                            placeholder="COIN"
                            aria-label="allocation coin"
                          />
                          <div className="flex items-center gap-1">
                            <input
                              type="number"
                              value={a.weightPct}
                              onChange={(e) => updateAllocation(i, { weightPct: Number(e.target.value) })}
                              className="w-full min-w-0"
                              aria-label={`${a.coin || 'allocation'} weight`}
                            />
                            <span className="text-text-secondary text-[11px]">%</span>
                          </div>
                          <div className="self-center" title={lock}>
                            <Segmented
                              label={`${a.coin || 'allocation'} side`}
                              options={SIDE_OPTIONS}
                              value={a.side ?? 'long'}
                              onChange={(side) => updateAllocation(i, { side })}
                              disabled={stable}
                            />
                          </div>
                          <div className="flex items-center gap-1" title={lock}>
                            <input
                              type="number"
                              min={1}
                              max={50}
                              step={1}
                              value={a.leverage ?? 1}
                              onChange={(e) => updateAllocation(i, { leverage: Number(e.target.value) })}
                              disabled={stable}
                              className="w-full min-w-0"
                              aria-label={`${a.coin || 'allocation'} leverage`}
                            />
                            <span className="text-text-secondary text-[11px]">×</span>
                          </div>
                          <Button tier="danger" className="!px-1.5" onClick={() => removeAllocation(i)}>
                            ✕
                          </Button>
                        </div>
                      )
                    })}
                  </div>
                </div>
                <div className="flex items-center justify-between">
                  <Button tier="ghost" onClick={addAllocation}>
                    + ADD COIN
                  </Button>
                  <span className={`text-[11px] tabular ${weightsValid ? 'text-green' : 'text-red-text'}`}>
                    {weightsValid ? `Σ ${weightSum}%` : `Σ ${weightSum}% — must equal 100`}
                  </span>
                </div>
                {!levValid && <span className="text-[11px] text-red-text">leverage must be 1–50</span>}
              </div>

              <div className="flex flex-col gap-1.5 pt-1 border-t border-border-subtle">
                <span className="label">DCA</span>
                {form.dca.length > 0 && (
                  <div className="table-scroll">
                    <div className="flex flex-col gap-1 min-w-max">
                      <div className={`${DCA_GRID} label`}>
                        <span>COIN</span>
                        <span>AMOUNT</span>
                        <span>EVERY</span>
                      </div>
                      {form.dca.map((d, i) => (
                        <div key={i} className={DCA_GRID}>
                          <input
                            value={d.coin}
                            onChange={(e) => updateDca(i, { coin: e.target.value.toUpperCase() })}
                            className="w-full"
                            placeholder="COIN"
                            aria-label="DCA coin"
                          />
                          <div className="flex items-center gap-1">
                            <span className="text-text-secondary text-[11px]">$</span>
                            <input
                              type="number"
                              min={1}
                              value={d.amountUsd}
                              onChange={(e) => updateDca(i, { amountUsd: Number(e.target.value) })}
                              className="w-full min-w-0"
                              aria-label="DCA amount USD"
                            />
                          </div>
                          <Segmented
                            label={`DCA ${d.coin || 'row'} every`}
                            options={DCA_EVERY_OPTIONS}
                            value={d.every}
                            onChange={(every) => updateDca(i, { every })}
                            className="self-center"
                          />
                          <Button
                            tier="danger"
                            className="!px-1.5"
                            onClick={() => patch({ dca: form.dca.filter((_, idx) => idx !== i) })}
                          >
                            ✕
                          </Button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                <div>
                  <Button
                    tier="ghost"
                    disabled={form.dca.length >= 8}
                    onClick={() =>
                      patch({
                        dca: [...form.dca, { coin: '', amountUsd: 100, every: 'weekly' }],
                        rebalance: 'none',
                      })
                    }
                  >
                    + ADD DCA
                  </Button>
                </div>
                <span className="text-[10px] text-text-secondary">buys from the USDC/USDT sleeve; stops when it runs out</span>
                {!dcaValid && (
                  <span className="text-[11px] text-red-text">each DCA row needs a coin and an amount above $0</span>
                )}
                {form.dca.length > 0 && !form.allocations.some((a) => STABLES.has(a.coin.toUpperCase())) && (
                  <span className="text-[10px] text-amber">no USDC/USDT allocation — DCA has nothing to spend</span>
                )}
              </div>

              <div className="flex flex-col gap-1.5 pt-1 border-t border-border-subtle">
                <span className="label">REBALANCE</span>
                <Segmented
                  label="rebalance"
                  options={REBALANCE_OPTIONS}
                  value={form.rebalance}
                  onChange={(rebalance) => patch({ rebalance })}
                  disabled={form.dca.length > 0}
                  className="self-start"
                />
                {form.dca.length > 0 && (
                  <span className="text-[10px] text-text-secondary">
                    NONE — DCA needs no rebalance (a rebalance would undo the buys)
                  </span>
                )}
              </div>

              <div className="flex flex-col gap-1.5 pt-1 border-t border-border-subtle">
                <span className="label">SCENARIO</span>
                {!form.scenario && (
                  <Button
                    tier="ghost"
                    disabled={perp}
                    onClick={() =>
                      patch({
                        scenario: {
                          horizonDays: 180,
                          paths: 200,
                          assumptions: nonStableCoins.map((coin) => ({ coin, annualReturnPct: 30, annualVolPct: 60 })),
                        },
                      })
                    }
                  >
                    + ADD PROJECTION
                  </Button>
                )}
                {perp && (
                  <span className={perpConflict ? 'text-[11px] text-red-text' : 'text-[10px] text-text-secondary'}>
                    {perpConflict ? 'remove the projection or the perp leg' : 'projection unavailable'} — Monte Carlo
                    models unlevered long-only portfolios
                  </span>
                )}
                {form.scenario && (
                  <div className="flex flex-col gap-1.5">
                    <div className="flex items-center gap-1.5">
                      <label className="flex items-center gap-1">
                        <span className="text-[10px] text-text-secondary">DAYS</span>
                        <input
                          type="number"
                          min={1}
                          className="w-[6ch]"
                          disabled={perp}
                          value={form.scenario.horizonDays}
                          onChange={(e) => patch({ scenario: { ...form.scenario!, horizonDays: Number(e.target.value) } })}
                        />
                      </label>
                      <label className="flex items-center gap-1">
                        <span className="text-[10px] text-text-secondary">PATHS</span>
                        <input
                          type="number"
                          min={1}
                          className="w-[6ch]"
                          disabled={perp}
                          value={form.scenario.paths}
                          onChange={(e) => patch({ scenario: { ...form.scenario!, paths: Number(e.target.value) } })}
                        />
                      </label>
                    </div>
                    {(resolvedScenario?.assumptions ?? []).map((a) => (
                      <div key={a.coin} className="flex items-center gap-1.5 text-[11px]">
                        <span className="w-[5ch] text-text-secondary">{a.coin}</span>
                        <input
                          type="number"
                          className="w-[6ch]"
                          disabled={perp}
                          value={a.annualReturnPct}
                          onChange={(e) => updateAssumption(a.coin, { annualReturnPct: Number(e.target.value) })}
                        />
                        <span className="text-text-secondary text-[10px]">% RET</span>
                        <input
                          type="number"
                          className="w-[6ch]"
                          disabled={perp}
                          value={a.annualVolPct}
                          onChange={(e) => updateAssumption(a.coin, { annualVolPct: Number(e.target.value) })}
                        />
                        <span className="text-text-secondary text-[10px]">% VOL</span>
                      </div>
                    ))}
                    <Button tier="danger" onClick={() => setRemoveProjectionOpen(true)} className="self-start">
                      REMOVE PROJECTION
                    </Button>
                  </div>
                )}
              </div>

              <Button tier="neutral" onClick={run} disabled={busy !== 'idle' || !editorOk} style={{ height: 'var(--control-lg)' }}>
                <span className={busy === 'running' ? 'pulse-label' : undefined}>
                  {busy === 'running' ? 'RUNNING…' : 'RUN SIMULATION'}
                </span>
              </Button>

              {saveError && <ErrorBlock message={saveError} />}

              <div className="flex gap-2">
                <Button tier="neutral" className="flex-1" onClick={save} disabled={!canSubmit}>
                  <span className={busy === 'saving' ? 'pulse-label' : undefined}>
                    {busy === 'saving' ? 'SAVING…' : 'SAVE'}
                  </span>
                </Button>
                <Button tier="danger" onClick={() => setDeleteOpen(true)}>
                  DELETE
                </Button>
              </div>
            </div>
          </div>

          {/* DRAWDOWN */}
          <div className="order-3 lg:order-none lg:col-start-5 lg:col-span-8 lg:row-start-2 panel">
            <div className="panel-header">
              <span className="panel-title">DRAWDOWN</span>
              {result && (
                <span className={`text-[11px] tabular ${maxDdClass(result.stats.maxDrawdownPct)}`}>
                  MAX DD {fmtPct(-Math.abs(result.stats.maxDrawdownPct) / 100, { decimals: 1 })}
                </span>
              )}
            </div>
            <div className="panel-body p-3">
              {!result && <EmptyBlock label="not simulated yet" />}
              {result && <DrawdownChart equity={result.equity} />}
            </div>
          </div>

          {/* STATS */}
          <div className="order-4 lg:order-none lg:col-start-5 lg:col-span-8 lg:row-start-3 panel">
            <div className="panel-header">
              <span className="panel-title">STATS</span>
            </div>
            <div className="panel-body p-3">
              {!result && <EmptyBlock label="not simulated yet" />}
              {result && (
                <>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    <div className="flex flex-col gap-0.5">
                      <span className="label">CAGR</span>
                      <span className={`tabular ${signClass(result.stats.cagrPct)}`}>
                        {fmtPct(result.stats.cagrPct / 100, { decimals: 1, sign: true })}
                      </span>
                    </div>
                    <div className="flex flex-col gap-0.5">
                      <span className="label">MAX DD</span>
                      <span className={`tabular ${maxDdClass(result.stats.maxDrawdownPct)}`}>
                        {fmtPct(-Math.abs(result.stats.maxDrawdownPct) / 100, { decimals: 1 })}
                      </span>
                    </div>
                    <div className="flex flex-col gap-0.5">
                      <span className="label">FINAL</span>
                      <span className="tabular text-text-primary">{fmtUsd(result.stats.finalValue, { decimals: 0 })}</span>
                    </div>
                    <div className="flex flex-col gap-0.5">
                      <span className="label">VS BTC</span>
                      <span className={`tabular ${signClass(result.stats.vsBtcPct)}`}>
                        {fmtPct(result.stats.vsBtcPct / 100, { decimals: 1, sign: true })}
                      </span>
                    </div>
                    <div className="flex flex-col gap-0.5">
                      <span className="label">VS USDC</span>
                      <span className={`tabular ${signClass(result.stats.vsUsdcPct)}`}>
                        {fmtPct(result.stats.vsUsdcPct / 100, { decimals: 1, sign: true })}
                      </span>
                    </div>
                  </div>
                  <div className="text-[10px] text-text-secondary mt-3">COMPUTED —</div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {deleteOpen && (
        <ConfirmDialog
          title="DELETE BRANCH"
          body={`Delete "${form?.name}"? Its simulation history goes with it.`}
          confirmLabel="DELETE"
          onConfirm={doDelete}
          onCancel={() => {
            setDeleteOpen(false)
            setDeleteError(null)
          }}
          error={deleteError}
        />
      )}

      {removeProjectionOpen && (
        <ConfirmDialog
          title="REMOVE PROJECTION"
          body="Remove the forward projection scenario from this branch?"
          confirmLabel="REMOVE"
          onConfirm={() => {
            patch({ scenario: null })
            setRemoveProjectionOpen(false)
          }}
          onCancel={() => setRemoveProjectionOpen(false)}
        />
      )}
    </div>
  )
}
