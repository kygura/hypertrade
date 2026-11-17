import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import {
  AnimatedDigits,
  Button,
  ConfirmDialog,
  EmptyBlock,
  ErrorBlock,
  HowToRead,
  OfflineBlock,
  Segmented,
  SkeletonRows,
  StatCell,
  type Term,
} from '../components'
import { api, ApiError, useApi } from '../lib/api'
import { BranchConfigSchema, isPerp, STABLES } from '../../shared/schemas'
import type { Allocation, BranchConfig, Scenario } from '../../shared/types'
import type { BranchDetail as BranchDetailData, BranchResult } from '../components/branches/types'
import { EquityChart, EquityGuide } from '../components/charts/EquityChart'
import { ProjectionAssumptions } from '../components/charts/FanChart'
import { DrawdownChart, DrawdownGuide } from '../components/branches/DrawdownChart'
import { ScheduleList } from '../components/branches/ScheduleList'
import { MonthlyTable, ProjectionOdds, RollingPanel } from '../components/branches/BacktestPanels'
import { branchLine, branchReturnPct, maxDdClass, signClass, sumWeights } from '../components/branches/format'
import { fmtPct, fmtUsd } from '../../shared/format'

// /branches/:id — docs/design/README.md §10.4. Editor (left, 4 cols) + results (right,
// 8 cols: equity/fan, drawdown, stats), reordered on mobile so results
// (checked far more often than edited) lead: equity header → chart →
// config → drawdown → stats.

type Dca = NonNullable<BranchConfig['dca']>[number]
type Costs = NonNullable<BranchConfig['costs']>
type Cashflow = NonNullable<BranchConfig['cashflow']>

type Busy = 'idle' | 'saving' | 'running'

interface FormState {
  name: string
  description: string
  startDate: string
  endDate: string
  initialCapitalUsd: number
  allocations: Allocation[]
  rebalance: BranchConfig['rebalance']
  scenario: Scenario | null
  dca: Dca[]
  costs: Costs | null
  cashflow: Cashflow | null
  rollingWindowDays: number | undefined
  schedule: NonNullable<BranchConfig['schedule']>
}

const ROLLING_OPTIONS: { value: number; label: string }[] = [
  { value: -1, label: 'AUTO' },
  { value: 30, label: '30D' },
  { value: 90, label: '90D' },
  { value: 365, label: '1Y' },
  { value: 0, label: 'OFF' },
]

const METHOD_OPTIONS: { value: 'bootstrap' | 'gbm'; label: string }[] = [
  { value: 'bootstrap', label: 'HISTORY' },
  { value: 'gbm', label: 'ASSUMED' },
]

const FLOW_SIGN_OPTIONS: { value: 1 | -1; label: string }[] = [
  { value: 1, label: 'ADD' },
  { value: -1, label: 'WITHDRAW' },
]

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

// Reading guides: what each field and number means in the simulation (src/server/sim/engine.ts, montecarlo.ts).
const CONFIG_TERMS: readonly Term[] = [
  ['START / CAPITAL', 'the day the simulation begins and the USD it begins with.'],
  ['WEIGHT', 'percent of the capital put in that coin on the start date. Weights must add to 100.'],
  ['SIDE', 'LONG holds the coin. SHORT is a perp leg that gains when the price falls. Stablecoins are spot only.'],
  ['LEV', 'leverage of a perp leg, 1 to 50: the weight is its margin and the position is margin × leverage. A leg is wiped out when its loss reaches its whole margin, checked on the daily low or high.'],
  ['DCA', 'a scheduled buy: each week or month the amount moves from the USDC/USDT part into the coin at that day\'s close, until the stablecoins run out.'],
  ['REBALANCE', 'when the weights are reset to target: never, on the first day of each month, once a week, or (5% BAND) whenever any weight is more than 5 percentage points off target.'],
  ['COSTS', 'FEE BPS is charged on every trade (entry, rebalance, DCA, deposits, withdrawals; 4.5 bps is about a Hyperliquid taker fill). FUNDING % is a yearly rate charged daily on perp positions: longs pay a positive rate, shorts receive it.'],
  ['CASH FLOW', 'money added or taken out every week or month. Added money is invested at the target weights; a withdrawal sells the same share of everything. Returns are then time-weighted so deposits do not count as gains.'],
  ['ROLLING', 'how long each window is when the same recipe is replayed from many past start dates. AUTO picks 1Y, 90D or 30D, whichever fits twice in the history.'],
  ['SCENARIO', 'an optional projection past today. DAYS is how far ahead, PATHS how many random futures are drawn, TARGET an end value whose odds are reported. The cash flow keeps going in the projection.'],
  ['HISTORY', 'builds each future from random blocks of this branch\'s own past days (BLOCK days long), fees, funding and perp legs included. It cannot show anything the history did not contain.'],
  ['% RET / % VOL', 'ASSUMED only: the yearly return and volatility you assume for each coin, coins treated as uncorrelated, no perp legs. It shows your assumptions, not a forecast.'],
  ['amber square', 'the form has unsaved changes. RUN SIMULATION replays the saved branch; SAVE stores the form and then runs it.'],
]

const STATS_TERMS: readonly Term[] = [
  ['RETURN', 'time-weighted return: the growth of the strategy with deposits and withdrawals taken out.'],
  ['CAGR', 'that growth expressed per year.'],
  ['MAX DD', 'max drawdown: the deepest fall of the strategy from an earlier high (deposits and withdrawals taken out). Red from 20%.'],
  ['FINAL', 'the portfolio\'s value on the latest daily close.'],
  ['VS BTC', 'how much higher or lower the branch ended than the same capital (and cash flows) held in BTC over the same days, as a percent of the BTC result.'],
  ['VS USDC', 'the same against capital left in USDC.'],
  ['VOL', 'how much the daily returns swing, scaled to a year.'],
  ['SHARPE / SORTINO', 'average daily return over its swing (Sortino counts only the down days), scaled to a year, with no risk-free rate. Above 1 is uncommon for long stretches.'],
  ['CALMAR', 'CAGR divided by max drawdown: yearly growth per unit of the worst fall.'],
  ['LONGEST DD', 'the most days spent below an earlier high before getting back to it.'],
  ['FEES / FUNDING', 'what trading and perp funding cost over the run (negative funding was received).'],
  ['NET IN', 'deposits minus withdrawals over the run.'],
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
        endDate: data.config.endDate ?? '',
        initialCapitalUsd: data.config.initialCapitalUsd,
        allocations: data.config.allocations,
        rebalance: data.config.rebalance,
        scenario: data.config.scenario ?? null,
        dca: data.config.dca ?? [],
        costs: data.config.costs ?? null,
        cashflow: data.config.cashflow ?? null,
        rollingWindowDays: data.config.rollingWindowDays,
        schedule: data.config.schedule ?? [],
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
        ...form.scenario,
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
        endDate: form.endDate || undefined,
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
        costs: form.costs ?? undefined,
        cashflow: form.cashflow ?? undefined,
        rollingWindowDays: form.rollingWindowDays,
        schedule: form.schedule.length ? form.schedule : undefined,
      }
    : null

  const weightSum = form ? sumWeights(form.allocations) : 0
  const weightsValid = Math.abs(weightSum - 100) < 0.01
  const parsedConfig = configCandidate ? BranchConfigSchema.safeParse(configCandidate) : null
  const levValid = !form || form.allocations.every((a) => (a.leverage ?? 1) >= 1 && (a.leverage ?? 1) <= 50)
  const dcaValid = !form || form.dca.every((d) => d.coin.trim() !== '' && d.amountUsd > 0)
  const perp = !!form && form.allocations.some(isPerp)
  const perpConflict = perp && !!form?.scenario && form.scenario.method !== 'bootstrap'
  const flowValid = !form?.cashflow || (Number.isFinite(form.cashflow.amountUsd) && form.cashflow.amountUsd !== 0)
  const editorOk = levValid && dcaValid && flowValid && !perpConflict
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
      <div className="mb-3">
        <Button tier="ghost" onClick={() => navigate('/branches')}>
          ← BRANCHES
        </Button>
      </div>

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
                <EmptyBlock label="not simulated yet: run it to see the branch's value over time against BTC and USDC" action={{ label: 'RUN SIMULATION', onClick: run }} />
              )}
              {!result && busy === 'running' && <SkeletonRows rows={4} />}
              {result && (
                <div style={{ opacity: busy === 'running' ? 0.7 : 1 }}>
                  {branchLine(result, form.initialCapitalUsd) && <p className="text-md text-text-primary mb-2">{branchLine(result, form.initialCapitalUsd)}</p>}
                  <div className="mb-1">
                    <span className="text-xl tabular">
                      <AnimatedDigits text={fmtUsd(result.stats.finalValue, { decimals: 0 })} />
                    </span>
                  </div>
                  <div className="text-md tabular mb-3">
                    <span className={signClass(branchReturnPct(result, form.initialCapitalUsd))}>
                      {fmtPct(branchReturnPct(result, form.initialCapitalUsd) / 100, { decimals: 1, sign: true })}
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
                    <div className="mt-2 flex flex-col gap-2">
                      <ProjectionAssumptions scenario={resolvedScenario} cashflow={form.cashflow ?? undefined} />
                      {result.montecarlo.summary && (
                        <ProjectionOdds summary={result.montecarlo.summary} horizonDays={resolvedScenario.horizonDays} targetUsd={resolvedScenario.targetUsd} />
                      )}
                    </div>
                  )}
                  {result.notes?.map((n) => (
                    <div key={n} className="text-xs text-amber mt-2">
                      {n}
                    </div>
                  ))}
                  <EquityGuide projection={result.montecarlo != null} className="mt-2" />
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
          <div className="order-2 lg:order-none lg:col-start-1 lg:col-span-4 lg:row-start-1 lg:row-span-5 panel">
            <div className="panel-header">
              <span className="flex items-center gap-1.5">
                <span className="panel-title">CONFIG</span>
                {dirty && <span className="inline-block w-1.5 h-1.5 bg-amber" title="unsaved changes" />}
              </span>
            </div>
            <div className="panel-body p-3 flex flex-col gap-3">
              <HowToRead terms={CONFIG_TERMS}>
                The recipe for the what-if: how much capital, from which day, split across which coins, and how it is maintained. Nothing here places an order.
              </HowToRead>
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
                <span className="label">END (EMPTY = TODAY)</span>
                <input type="date" value={form.endDate} onChange={(e) => patch({ endDate: e.target.value })} className="w-full" />
              </label>
              {form.schedule.length > 0 && (
                <div className="flex flex-col gap-1.5 pt-1 border-t border-border-subtle">
                  <span className="label">MOVES (FILLED AT THE DAY'S CLOSE; ALLOCATIONS HOLD UNTIL THE FIRST)</span>
                  <ScheduleList
                    schedule={form.schedule}
                    filled={dirty ? undefined : result?.moves}
                    onRemove={(i) => patch({ schedule: form.schedule.filter((_, idx) => idx !== i) })}
                  />
                </div>
              )}
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
                      <span title="leverage of a perp leg, 1 to 50">LEV</span>
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
                            <span className="text-text-secondary text-sm">%</span>
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
                            <span className="text-text-secondary text-sm">×</span>
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
                  <span className={`text-sm tabular ${weightsValid ? 'text-green' : 'text-red-text'}`}>
                    {weightsValid ? `Σ ${weightSum}%` : `Σ ${weightSum}% — must equal 100`}
                  </span>
                </div>
                {!levValid && <span className="text-sm text-red-text">leverage must be 1–50</span>}
              </div>

              <div className="flex flex-col gap-1.5 pt-1 border-t border-border-subtle">
                <span className="label" title="dollar-cost averaging: a fixed USD amount bought on a schedule">DCA</span>
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
                            <span className="text-text-secondary text-sm">$</span>
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
                <span className="text-xs text-text-secondary">buys from the USDC/USDT sleeve; stops when it runs out</span>
                {!dcaValid && (
                  <span className="text-sm text-red-text">each DCA row needs a coin and an amount above $0</span>
                )}
                {form.dca.length > 0 && !form.allocations.some((a) => STABLES.has(a.coin.toUpperCase())) && (
                  <span className="text-xs text-amber">no USDC/USDT allocation — DCA has nothing to spend</span>
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
                  <span className="text-xs text-text-secondary">
                    NONE — DCA needs no rebalance (a rebalance would undo the buys)
                  </span>
                )}
              </div>

              <div className="flex flex-col gap-1.5 pt-1 border-t border-border-subtle">
                <span className="label">COSTS</span>
                {!form.costs ? (
                  <Button tier="ghost" className="self-start" onClick={() => patch({ costs: { feeBps: 4.5 } })}>
                    + ADD COSTS
                  </Button>
                ) : (
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <label className="flex items-center gap-1">
                      <span className="text-xs text-text-secondary">FEE BPS</span>
                      <input
                        type="number"
                        min={0}
                        max={500}
                        step={0.5}
                        className="w-[7ch]"
                        value={form.costs.feeBps}
                        onChange={(e) => patch({ costs: { ...form.costs!, feeBps: Number(e.target.value) } })}
                        aria-label="fee in basis points"
                      />
                    </label>
                    <label className="flex items-center gap-1" title="yearly funding rate on perp positions; longs pay a positive rate">
                      <span className="text-xs text-text-secondary">FUNDING %/Y</span>
                      <input
                        type="number"
                        min={-200}
                        max={200}
                        className="w-[7ch]"
                        value={form.costs.fundingAprPct ?? 0}
                        onChange={(e) => {
                          const v = Number(e.target.value)
                          const { fundingAprPct: _drop, ...rest } = form.costs!
                          patch({ costs: v ? { ...rest, fundingAprPct: v } : rest })
                        }}
                        aria-label="funding rate percent per year"
                      />
                    </label>
                    <Button tier="danger" className="!px-1.5" onClick={() => patch({ costs: null })}>
                      ✕
                    </Button>
                  </div>
                )}
                {!form.costs && <span className="text-xs text-text-secondary">no fees or funding charged</span>}
              </div>

              <div className="flex flex-col gap-1.5 pt-1 border-t border-border-subtle">
                <span className="label" title="money added or withdrawn on a schedule">CASH FLOW</span>
                {!form.cashflow ? (
                  <Button tier="ghost" className="self-start" onClick={() => patch({ cashflow: { amountUsd: 500, every: 'monthly' } })}>
                    + ADD CASH FLOW
                  </Button>
                ) : (
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <Segmented
                      label="cash flow direction"
                      options={FLOW_SIGN_OPTIONS}
                      value={form.cashflow.amountUsd < 0 ? -1 : 1}
                      onChange={(sign) => patch({ cashflow: { ...form.cashflow!, amountUsd: sign * Math.abs(form.cashflow!.amountUsd) } })}
                    />
                    <span className="text-text-secondary text-sm">$</span>
                    <input
                      type="number"
                      min={1}
                      className="w-[8ch]"
                      value={Math.abs(form.cashflow.amountUsd)}
                      onChange={(e) =>
                        patch({ cashflow: { ...form.cashflow!, amountUsd: (form.cashflow!.amountUsd < 0 ? -1 : 1) * Number(e.target.value) } })
                      }
                      aria-label="cash flow amount USD"
                    />
                    <Segmented
                      label="cash flow every"
                      options={DCA_EVERY_OPTIONS}
                      value={form.cashflow.every}
                      onChange={(every) => patch({ cashflow: { ...form.cashflow!, every } })}
                    />
                    <Button tier="danger" className="!px-1.5" onClick={() => patch({ cashflow: null })}>
                      ✕
                    </Button>
                  </div>
                )}
                {!flowValid && <span className="text-sm text-red-text">the cash flow needs an amount above $0</span>}
              </div>

              <div className="flex flex-col gap-1.5 pt-1 border-t border-border-subtle">
                <span className="label" title="window length for replaying the recipe from many past start dates">ROLLING</span>
                <Segmented
                  label="rolling window"
                  options={ROLLING_OPTIONS}
                  value={form.rollingWindowDays ?? -1}
                  onChange={(v) => patch({ rollingWindowDays: v < 0 ? undefined : v })}
                  className="self-start"
                />
              </div>

              <div className="flex flex-col gap-1.5 pt-1 border-t border-border-subtle">
                <span className="label">SCENARIO</span>
                {!form.scenario && (
                  <Button
                    tier="ghost"
                    className="self-start"
                    onClick={() =>
                      patch({
                        scenario: {
                          horizonDays: 365,
                          paths: 300,
                          method: 'bootstrap',
                          assumptions: nonStableCoins.map((coin) => ({ coin, annualReturnPct: 30, annualVolPct: 60 })),
                        },
                      })
                    }
                  >
                    + ADD PROJECTION
                  </Button>
                )}
                {perpConflict && (
                  <span className="text-sm text-red-text">
                    ASSUMED only models portfolios with no short or leveraged leg: switch to HISTORY or remove the perp leg
                  </span>
                )}
                {form.scenario && (
                  <div className="flex flex-col gap-1.5">
                    <Segmented
                      label="projection method"
                      options={METHOD_OPTIONS}
                      value={form.scenario.method ?? 'gbm'}
                      onChange={(method) => patch({ scenario: { ...form.scenario!, method } })}
                      className="self-start"
                    />
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <label className="flex items-center gap-1">
                        <span className="text-xs text-text-secondary">DAYS</span>
                        <input
                          type="number"
                          min={1}
                          className="w-[8ch]"
                          value={form.scenario.horizonDays}
                          onChange={(e) => patch({ scenario: { ...form.scenario!, horizonDays: Number(e.target.value) } })}
                        />
                      </label>
                      <label className="flex items-center gap-1">
                        <span className="text-xs text-text-secondary">PATHS</span>
                        <input
                          type="number"
                          min={1}
                          className="w-[8ch]"
                          value={form.scenario.paths}
                          onChange={(e) => patch({ scenario: { ...form.scenario!, paths: Number(e.target.value) } })}
                        />
                      </label>
                      {form.scenario.method === 'bootstrap' && (
                        <label className="flex items-center gap-1" title="length of each block of consecutive past days stitched into a path">
                          <span className="text-xs text-text-secondary">BLOCK</span>
                          <input
                            type="number"
                            min={1}
                            max={90}
                            className="w-[5ch]"
                            value={form.scenario.blockDays ?? 10}
                            onChange={(e) => patch({ scenario: { ...form.scenario!, blockDays: Number(e.target.value) } })}
                          />
                        </label>
                      )}
                      <label className="flex items-center gap-1" title="the projection reports the share of paths that end at or above this value">
                        <span className="text-xs text-text-secondary">TARGET $</span>
                        <input
                          type="number"
                          min={0}
                          className="w-[11ch]"
                          value={form.scenario.targetUsd ?? ''}
                          placeholder="—"
                          onChange={(e) => {
                            const v = Number(e.target.value)
                            const { targetUsd: _drop, ...rest } = form.scenario!
                            patch({ scenario: v > 0 ? { ...rest, targetUsd: v } : rest })
                          }}
                        />
                      </label>
                    </div>
                    {form.scenario.method !== 'bootstrap' && (resolvedScenario?.assumptions ?? []).map((a) => (
                      <div key={a.coin} className="flex items-center gap-1.5 text-sm">
                        <span className="w-[5ch] text-text-secondary">{a.coin}</span>
                        <input
                          type="number"
                          className="w-[6ch]"
                          value={a.annualReturnPct}
                          onChange={(e) => updateAssumption(a.coin, { annualReturnPct: Number(e.target.value) })}
                        />
                        <span className="text-text-secondary text-xs" title="assumed yearly return of this coin, in percent">% RET</span>
                        <input
                          type="number"
                          className="w-[6ch]"
                          value={a.annualVolPct}
                          onChange={(e) => updateAssumption(a.coin, { annualVolPct: Number(e.target.value) })}
                        />
                        <span className="text-text-secondary text-xs" title="assumed yearly volatility of this coin, in percent">% VOL</span>
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
                <span className={`text-sm tabular ${maxDdClass(result.stats.maxDrawdownPct)}`} title="max drawdown: the deepest fall from an earlier high">
                  MAX DD {fmtPct(-Math.abs(result.stats.maxDrawdownPct) / 100, { decimals: 1 })}
                </span>
              )}
            </div>
            <div className="panel-body p-3">
              {!result && <EmptyBlock label="not simulated yet: how far the branch fell below its own highs shows here after a run" />}
              {result && <DrawdownChart equity={result.twr ?? result.equity} />}
              {result && <DrawdownGuide className="mt-2" />}
            </div>
          </div>

          {/* STATS */}
          <div className="order-4 lg:order-none lg:col-start-5 lg:col-span-8 lg:row-start-3 panel">
            <div className="panel-header">
              <span className="panel-title">STATS</span>
            </div>
            <div className="panel-body p-3">
              {!result && <EmptyBlock label="not simulated yet: yearly growth, max drawdown and the result against BTC and USDC show here after a run" />}
              {result && (
                <>
                  <HowToRead terms={STATS_TERMS} className="mb-3">
                    The simulation summed up, each number over the whole period from the start date to the latest daily close.
                  </HowToRead>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    <StatCell label="RETURN" className={signClass(branchReturnPct(result, form.initialCapitalUsd))}>
                      {fmtPct(branchReturnPct(result, form.initialCapitalUsd) / 100, { decimals: 1, sign: true })}
                    </StatCell>
                    <StatCell label="CAGR" className={signClass(result.stats.cagrPct)}>
                      {fmtPct(result.stats.cagrPct / 100, { decimals: 1, sign: true })}
                    </StatCell>
                    <StatCell label="MAX DD" className={maxDdClass(result.stats.maxDrawdownPct)}>
                      {fmtPct(-Math.abs(result.stats.maxDrawdownPct) / 100, { decimals: 1 })}
                    </StatCell>
                    <StatCell label="FINAL">{fmtUsd(result.stats.finalValue, { decimals: 0 })}</StatCell>
                    <StatCell label="VS BTC" className={signClass(result.stats.vsBtcPct)}>
                      {fmtPct(result.stats.vsBtcPct / 100, { decimals: 1, sign: true })}
                    </StatCell>
                    <StatCell label="VS USDC" className={signClass(result.stats.vsUsdcPct)}>
                      {fmtPct(result.stats.vsUsdcPct / 100, { decimals: 1, sign: true })}
                    </StatCell>
                    {result.stats.volPct != null && (
                      <>
                        <StatCell label="VOL">{fmtPct(result.stats.volPct / 100, { decimals: 1 })}</StatCell>
                        <StatCell label="SHARPE / SORTINO">
                          {result.stats.sharpe!.toFixed(2)} / {result.stats.sortino!.toFixed(2)}
                        </StatCell>
                        <StatCell label="CALMAR">{result.stats.calmar!.toFixed(2)}</StatCell>
                        <StatCell label="LONGEST DD">{result.stats.longestDrawdownDays}D</StatCell>
                        <StatCell label="FEES">{fmtUsd(result.stats.feesUsd ?? 0, { decimals: 0 })}</StatCell>
                        <StatCell label="FUNDING">{fmtUsd(result.stats.fundingUsd ?? 0, { decimals: 0 })}</StatCell>
                        {!!result.stats.netFlowUsd && <StatCell label="NET IN">{fmtUsd(result.stats.netFlowUsd, { decimals: 0 })}</StatCell>}
                      </>
                    )}
                  </div>
                  <div className="text-xs text-text-secondary mt-3">
                    historical simulation on daily closes · {form.costs ? `fees ${form.costs.feeBps} bps${form.costs.fundingAprPct ? `, funding ${form.costs.fundingAprPct}%/y on perp legs` : ''}` : 'no fees or funding charged'} · no slippage · a perp leg is liquidated only when its whole margin is lost
                  </div>
                </>
              )}
            </div>
          </div>

          {/* ROLLING STARTS */}
          <div className="order-5 lg:order-none lg:col-start-5 lg:col-span-8 lg:row-start-4 panel">
            <div className="panel-header">
              <span className="panel-title">ROLLING STARTS</span>
              {result?.rolling && <span className="text-sm text-text-secondary tabular">{result.rolling.windowDays}D WINDOWS</span>}
            </div>
            <div className="panel-body p-3">
              {!result && <EmptyBlock label="not simulated yet: the same recipe replayed from many past start dates shows here after a run" />}
              {result && !result.rolling && (
                <EmptyBlock label={form.schedule.length ? 'rolling starts are off: scheduled moves sit on fixed dates' : form.rollingWindowDays === 0 ? 'rolling starts are off (ROLLING in the config)' : 'history too short: rolling starts need at least twice the window (60 days for 30D)'} />
              )}
              {result?.rolling && <RollingPanel rolling={result.rolling} />}
            </div>
          </div>

          {/* MONTHLY */}
          <div className="order-6 lg:order-none lg:col-start-5 lg:col-span-8 lg:row-start-5 panel">
            <div className="panel-header">
              <span className="panel-title">MONTHLY RETURNS</span>
            </div>
            <div className="panel-body p-3">
              {!result?.monthly?.length ? (
                <EmptyBlock label="not simulated yet: the return of each calendar month, in percent, shows here after a run" />
              ) : (
                <MonthlyTable monthly={result.monthly} />
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
