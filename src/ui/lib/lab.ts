import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, NetworkError } from './api'
import { fmtUsd } from '../../shared/format'
import type {
  CatalogueEntry,
  CatalogueHealth,
  Condition,
  Direction,
  MarketPulse,
  MetricDef,
  Objective,
  PerfStats,
  PulseAsset,
  Rule,
  RuleEvaluation,
  SearchConfig,
  SearchConfigInput,
  SearchResult,
  Sensitivity,
  Transform,
  VerdictLevel,
} from '../../server/lab/types'
import type { RunSummary, StoredRun } from '../../server/lab/store'

// Typed client for the lab tool registry (LAB.md "Tool contract") plus the
// pure formatting/filter logic behind DESIGN.md §10.9. Wire shapes are the
// server's own types (type-only import, erased at build), so a contract
// change breaks typecheck here rather than a render.

export type {
  CatalogueEntry,
  CatalogueHealth,
  Condition,
  Direction,
  MarketPulse,
  MetricDef,
  Objective,
  PerfStats,
  PulseAsset,
  Rule,
  RuleEvaluation,
  RunSummary,
  SearchConfig,
  SearchConfigInput,
  SearchResult,
  Sensitivity,
  StoredRun,
  Transform,
  VerdictLevel,
}

export type CatalogueListEntry = CatalogueEntry & { live: PerfStats | null; flags: Array<'decayed' | 'overlap'> }

// ------------------------------------------------------------------ transport

const REDIRECT_KEY = 'ht_redirect_to'

type Envelope<T> = { ok: true; result: T } | { ok: false; error: string; field?: string }

export function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError'
}

/** POST /api/lab/tools/<name> with the args as body → result, or ApiError (with `field` on 400s) / NetworkError. */
export async function labCall<T>(name: string, args: object = {}, signal?: AbortSignal): Promise<T> {
  let res: Response
  try {
    res = await fetch(`/api/lab/tools/${encodeURIComponent(name)}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'x-lab-source': 'ui' },
      body: JSON.stringify(args),
      signal,
    })
  } catch (err) {
    if (isAbort(err)) throw err
    throw new NetworkError(err instanceof Error ? err.message : 'network unreachable')
  }
  if (res.status === 401) {
    sessionStorage.setItem(REDIRECT_KEY, location.pathname)
    location.href = '/login'
    throw new ApiError('unauthorized', 401)
  }
  const body = (await res.json().catch(() => null)) as Envelope<T> | null
  if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
  if (body && body.ok === true && res.ok) return body.result
  if (body && body.ok === false) throw new ApiError(body.error, res.status, typeof body.field === 'string' ? body.field : undefined)
  throw new ApiError(res.statusText || `HTTP ${res.status}`, res.status)
}

let metricsCache: Promise<MetricDef[]> | null = null

export const lab = {
  /** Whole catalogue, fetched once per page load (the picker filters by asset client-side). */
  metrics(): Promise<MetricDef[]> {
    metricsCache ??= labCall<{ metrics: MetricDef[] }>('lab_list_metrics').then((r) => r.metrics)
    metricsCache.catch(() => {
      metricsCache = null
    })
    return metricsCache
  },
  search: (config: SearchConfigInput, signal?: AbortSignal) =>
    labCall<{ runId: string | null; result: SearchResult }>('lab_search', config, signal),
  getRun: (id: string) => labCall<StoredRun>('lab_get_run', { id }),
  listRuns: (limit?: number) => labCall<{ runs: RunSummary[] }>('lab_list_runs', limit ? { limit } : {}).then((r) => r.runs),
  evaluate: (args: { rule: Rule; slippageBps?: number; includeEquity?: boolean; sensitivity?: boolean; windows?: number[]; trials?: number }) =>
    labCall<RuleEvaluation>('lab_evaluate_rule', args),
  sensitivity: (args: { rule: Rule; windows?: number[]; slippageBps?: number }) => labCall<Sensitivity>('lab_sensitivity', args),
  catalogue: () => labCall<{ entries: CatalogueListEntry[] }>('lab_catalogue_list', {}).then((r) => r.entries),
  save: (args: { rule: Rule; name: string; note?: string; runId?: string }) => labCall<CatalogueEntry>('lab_catalogue_save', args),
  remove: (id: string) => labCall<{ removed: boolean }>('lab_catalogue_remove', { id }),
  health: () => labCall<CatalogueHealth>('lab_catalogue_health'),
  pulse: () => labCall<MarketPulse>('lab_market_pulse'),
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export interface LabState<T> {
  data: T | null
  loading: boolean
  error: string | null
  offline: boolean
  refetch: () => void
  setData: (d: T) => void
}

/** One-shot loader for a lab call; `fetcher` null skips. Refetches keep the old data (no skeleton flash). */
export function useLab<T>(fetcher: (() => Promise<T>) | null, deps: unknown[]): LabState<T> {
  const [state, setState] = useState<{ data: T | null; loading: boolean; error: string | null; offline: boolean }>({
    data: null,
    loading: fetcher != null,
    error: null,
    offline: false,
  })
  const ref = useRef(fetcher)
  ref.current = fetcher
  const seq = useRef(0)

  const refetch = useCallback(() => {
    const f = ref.current
    if (!f) return
    const n = ++seq.current
    setState((s) => ({ ...s, loading: true, error: null, offline: false }))
    f().then(
      (data) => n === seq.current && setState({ data, loading: false, error: null, offline: false }),
      (err: unknown) => {
        if (n !== seq.current) return
        if (err instanceof ApiError && err.status === 401) return
        setState((s) => ({
          data: s.data,
          loading: false,
          error: err instanceof NetworkError ? null : errorText(err),
          offline: err instanceof NetworkError,
        }))
      },
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  useEffect(() => {
    refetch()
  }, [refetch])

  const setData = useCallback((data: T) => setState({ data, loading: false, error: null, offline: false }), [])
  return { ...state, refetch, setData }
}

// ------------------------------------------------------------------ storage (per-viewer conveniences)

export function readLocal<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw == null ? fallback : ({ ...fallback, ...JSON.parse(raw) } as T)
  } catch {
    return fallback
  }
}

export function readLocalRaw(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

export function writeLocal(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value))
  } catch {
    /* storage blocked: the page still works, it just forgets */
  }
}

// ------------------------------------------------------------------ number formatting

const MINUS = '−'

/** Typeset minus for display (U+2212). */
export function typeset(s: string): string {
  return s.startsWith('-') ? MINUS + s.slice(1) : s
}

/** 3 significant figures, trailing zeros dropped: −1.12, 0.9, 12300. */
export function fmtSig(n: number): string {
  if (!Number.isFinite(n)) return '—'
  return typeset(String(Number(n.toPrecision(3))))
}

/** Signed fixed: +1.42 / −0.97 / 0.00. */
export function fmtSigned(n: number | null | undefined, decimals = 2): string {
  if (n == null || !Number.isFinite(n)) return '—'
  const body = Math.abs(n).toFixed(decimals)
  if (Number(body) === 0) return (0).toFixed(decimals)
  return (n > 0 ? '+' : MINUS) + body
}

/** Fraction → signed percent; ≥100% drops the decimal (+212%, +4.2%, −18.4%). */
export function fmtPctSigned(frac: number | null | undefined): string {
  if (frac == null || !Number.isFinite(frac)) return '—'
  const v = frac * 100
  return fmtSigned(v, Math.abs(v) >= 100 ? 0 : 1) + '%'
}

/** Fraction → unsigned whole percent (hit rate, exposure). */
export function fmtPct0(frac: number | null | undefined): string {
  if (frac == null || !Number.isFinite(frac)) return '—'
  return `${Math.round(frac * 100)}%`
}

export function signTone(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return 'text-text-secondary'
  return n >= 0 ? 'text-green' : 'text-red-text'
}

/** MAX DD reads red past −20% (§10.9 SignalCard). */
export function ddTone(maxDrawdown: number | null | undefined): string {
  return maxDrawdown != null && maxDrawdown < -0.2 ? 'text-red-text' : 'text-text-primary'
}

export function shortId(id: string | null | undefined): string {
  return id ? id.slice(0, 4) : '—'
}

export function fmtUtcStamp(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
}

export function relTime(iso: string, now = Date.now()): string {
  const s = Math.max(0, (now - new Date(iso).getTime()) / 1000)
  if (!Number.isFinite(s)) return '—'
  if (s < 60) return `${Math.floor(s)}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86_400)}d ago`
}

/** Age of a YYYY-MM-DD (or ISO) date over `days` (default 2) → stale. */
export function isStaleDate(date: string, now = Date.now(), days = 2): boolean {
  const t = Date.parse(date.length === 10 ? `${date}T00:00:00Z` : date)
  return Number.isFinite(t) && now - t > days * 86_400_000
}

/** ISO stamp for a YYYY-MM-DD so StaleBanner/AgeStamp can read it. */
export function dateIso(date: string): string {
  return date.length === 10 ? `${date}T00:00:00Z` : date
}

// ------------------------------------------------------------------ rule text (§10.9 RuleText)

const TRANSFORM_PREFIX: Record<Transform, string> = {
  raw: '',
  z: 'z',
  rsi: 'rsi',
  ma_ratio: 'ma',
  roc: 'roc',
  vol: 'vol',
  pctile: 'pct',
}

export const LAB_TRANSFORMS = ['raw', 'z', 'rsi', 'ma_ratio', 'roc', 'vol', 'pctile'] as const satisfies readonly Transform[]

/** Short chip labels for the TRANSFORMS checkboxes. */
export const TRANSFORM_LABEL: Record<Transform, string> = {
  raw: 'raw',
  z: 'z',
  rsi: 'rsi',
  ma_ratio: 'ma',
  roc: 'roc',
  vol: 'vol',
  pctile: 'pctile',
}

export interface ParsedFeature {
  metric: string
  transform: Transform
  window: number
}

/** `cm:CapMVRVCur|z|90` → parts (split from the right: metric ids may hold anything but the last two `|`). */
export function parseFeature(feature: string): ParsedFeature {
  const parts = feature.split('|')
  if (parts.length < 3) return { metric: feature, transform: 'raw', window: 0 }
  const window = Number(parts[parts.length - 1])
  const transform = parts[parts.length - 2] as Transform
  return {
    metric: parts.slice(0, -2).join('|'),
    transform: transform in TRANSFORM_PREFIX ? transform : 'raw',
    window: Number.isFinite(window) ? window : 0,
  }
}

export function metricName(metricId: string, metrics: readonly MetricDef[]): string {
  const def = metrics.find((m) => m.id === metricId)
  if (def) return def.name
  const i = metricId.indexOf(':')
  return i >= 0 ? metricId.slice(i + 1) : metricId
}

/** `z(90) MVRV`, `funding` (raw), `pct(30) funding`. */
export function fmtFeature(feature: string, metrics: readonly MetricDef[]): string {
  const f = parseFeature(feature)
  const name = metricName(f.metric, metrics)
  const prefix = TRANSFORM_PREFIX[f.transform]
  return prefix ? `${prefix}(${f.window}) ${name}` : name
}

/**
 * A feature's value in our units: raw values follow the metric's `units`
 * (fraction → %, USD → compact), every transform is unitless → 3 sig figs.
 */
export function fmtFeatureValue(feature: string, value: number, metrics: readonly MetricDef[]): string {
  if (!Number.isFinite(value)) return '—'
  const f = parseFeature(feature)
  if (f.transform !== 'raw') return fmtSig(value)
  const units = metrics.find((m) => m.id === f.metric)?.units ?? ''
  if (units.startsWith('fraction')) return `${fmtSig(value * 100)}%`
  if (units === 'USD') return typeset(fmtUsd(value, { compact: true, decimals: 2 }))
  if (units === '%') return `${fmtSig(value)}%`
  return fmtSig(value)
}

export interface ConditionParts {
  feature: string
  op: '<' | '≥'
  threshold: string
}

export function conditionParts(c: Condition, metrics: readonly MetricDef[]): ConditionParts {
  return {
    feature: fmtFeature(c.feature, metrics),
    op: c.op === '<' ? '<' : '≥',
    threshold: fmtFeatureValue(c.feature, c.threshold, metrics),
  }
}

export function ruleTextPlain(rule: Pick<Rule, 'conditions'>, metrics: readonly MetricDef[]): string {
  return rule.conditions
    .map((c) => {
      const p = conditionParts(c, metrics)
      return `${p.feature} ${p.op} ${p.threshold}`
    })
    .join(' AND ')
}

/** The wire form, e.g. `cm:CapMVRVCur|z|90 < -1.12 AND ht:funding|raw|0 >= 0.0003` (RAW line, title). */
export function wireText(rule: Pick<Rule, 'conditions'>): string {
  return rule.conditions.map((c) => `${c.feature} ${c.op} ${c.threshold}`).join(' AND ')
}

/** SaveToCatalogueForm default name: rule text cut to 40ch. */
export function defaultRuleName(rule: Pick<Rule, 'conditions'>, metrics: readonly MetricDef[]): string {
  const t = ruleTextPlain(rule, metrics)
  return t.length <= 40 ? t : `${t.slice(0, 39).trimEnd()}…`
}

/** Distinct providers in a rule's conditions, in order. */
export function ruleProviders(rule: Pick<Rule, 'conditions'>): string[] {
  const out: string[] = []
  for (const c of rule.conditions) {
    const p = parseFeature(c.feature).metric.split(':')[0] ?? ''
    if (p && !out.includes(p)) out.push(p)
  }
  return out
}

export function conditionMet(c: Condition, value: number | null | undefined): boolean | null {
  if (value == null || !Number.isFinite(value)) return null
  return c.op === '<' ? value < c.threshold : value >= c.threshold
}

// ------------------------------------------------------------------ honesty rules + verdict words

/** Rule 1 overfit flag: holdout Sharpe has the opposite sign to walk-forward, or is below half of it. */
export function holdoutGap(wf: number | null | undefined, ho: number | null | undefined): boolean {
  if (wf == null || ho == null || !Number.isFinite(wf) || !Number.isFinite(ho)) return false
  if (wf === 0) return false
  if (Math.sign(ho) !== Math.sign(wf)) return true
  return Math.abs(ho) < Math.abs(wf) / 2
}

export type StabWord = { word: 'STABLE' | 'SOFT' | 'FRAGILE'; tone: string }

export function stabWord(stability: number): StabWord {
  if (stability >= 0.75) return { word: 'STABLE', tone: 'text-text-primary' }
  if (stability >= 0.5) return { word: 'SOFT', tone: 'text-amber' }
  return { word: 'FRAGILE', tone: 'text-red-text' }
}

export type SensTone = 'neg2' | 'neg1' | 'zero' | 'pos1'

export const SENS_BG: Record<SensTone, string> = {
  neg2: 'bg-mom-neg2',
  neg1: 'bg-mom-neg1',
  zero: 'bg-mom-zero',
  pos1: 'bg-mom-pos1',
}

/** Sensitivity cell ramp by sharpe / base.sharpe; never pos2 (beating the base is noise). */
export function sensitivityTone(sharpe: number, baseSharpe: number): SensTone {
  if (!Number.isFinite(sharpe) || !Number.isFinite(baseSharpe) || baseSharpe === 0) return 'zero'
  const r = sharpe / baseSharpe
  if (r < 0) return 'neg2'
  if (r < 0.5) return 'neg1'
  if (r < 1) return 'zero'
  return 'pos1'
}

/** LeanBar geometry: side of the center tick and fill width as % of the whole bar (|lean| × 50%). */
export function leanFill(lean: number): { side: 'left' | 'right' | null; pct: number } {
  if (!Number.isFinite(lean) || lean === 0) return { side: null, pct: 0 }
  const l = Math.max(-1, Math.min(1, lean))
  return { side: l > 0 ? 'right' : 'left', pct: Math.abs(l) * 50 }
}

export function sortPulse(assets: readonly PulseAsset[]): PulseAsset[] {
  return [...assets].sort((a, b) => Math.abs(b.lean) - Math.abs(a.lean) || a.asset.localeCompare(b.asset))
}

// ------------------------------------------------------------------ results filters (§10.9 ResultsFilters)

export type StatsWindow = 'is' | 'wf' | 'ho'
export type RuleKind = 'all' | 'pairs' | 'single'

export interface ResultsFilterState {
  kind: RuleKind
  window: StatsWindow
  minSharpe: string
  maxDd: string
  minHit: string
}

export const DEFAULT_FILTERS: ResultsFilterState = { kind: 'all', window: 'wf', minSharpe: '', maxDd: '', minHit: '' }

export function statsFor(ev: RuleEvaluation, w: StatsWindow): PerfStats | null {
  return w === 'is' ? ev.inSample : w === 'wf' ? ev.walkForward : ev.holdout
}

function num(s: string): number | null {
  if (s.trim() === '') return null
  const n = Number(s.replace('%', '').replace(MINUS, '-').trim())
  return Number.isFinite(n) ? n : null
}

/**
 * Client-side filters over the chosen stats window. Blank = off. MAX DD and
 * MIN HIT are percents (`-30`/`30` both mean drawdown no worse than −30%).
 * A rule with no stats in that window fails any active numeric filter.
 */
export function filterRules(rules: readonly RuleEvaluation[], f: ResultsFilterState): RuleEvaluation[] {
  const minSharpe = num(f.minSharpe)
  const maxDd = num(f.maxDd)
  const minHit = num(f.minHit)
  return rules.filter((r) => {
    if (f.kind === 'pairs' && r.rule.conditions.length < 2) return false
    if (f.kind === 'single' && r.rule.conditions.length !== 1) return false
    if (minSharpe == null && maxDd == null && minHit == null) return true
    const s = statsFor(r, f.window)
    if (!s) return false
    if (minSharpe != null && !(sharpeOf(s) != null && s.sharpe >= minSharpe)) return false
    if (maxDd != null && !(s.maxDrawdown >= -Math.abs(maxDd) / 100)) return false
    if (minHit != null && !(s.hitRate != null && s.hitRate >= minHit / 100)) return false
    return true
  })
}

// ------------------------------------------------------------------ search form (§10.9 LabSearchForm)

export interface SearchForm {
  asset: string
  direction: Direction
  metrics: string[]
  horizonDays: number
  objective: Objective
  trials: number
  transforms: Transform[]
  windows: string
  labelQuantile: string
  folds: string
  minSupport: string
  slippageBps: string
  topK: string
  from: string
  to: string
  seed: string
}

export const DEFAULT_FORM: SearchForm = {
  asset: 'BTC',
  direction: 'long',
  metrics: [],
  horizonDays: 14,
  objective: 'sharpe',
  trials: 40,
  transforms: [...LAB_TRANSFORMS],
  windows: '7, 30, 90',
  labelQuantile: '0.3',
  folds: '3',
  minSupport: '30',
  slippageBps: '10',
  topK: '10',
  from: '',
  to: '',
  seed: '42',
}

const ADVANCED_KEYS = ['transforms', 'windows', 'labelQuantile', 'folds', 'minSupport', 'slippageBps', 'topK', 'from', 'to', 'seed'] as const

export function parseWindows(text: string): { windows: number[] | null; error: string | null } {
  const parts = text
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
  if (parts.length === 0) return { windows: null, error: 'windows: enter at least one' }
  if (parts.length > 6) return { windows: null, error: 'windows: at most 6' }
  const out: number[] = []
  for (const p of parts) {
    const n = Number(p)
    if (!Number.isInteger(n)) return { windows: null, error: `windows: ${p} is not a whole number` }
    if (n < 2) return { windows: null, error: `windows: ${n} is below 2` }
    if (n > 365) return { windows: null, error: `windows: ${n} is above 365` }
    if (!out.includes(n)) out.push(n)
  }
  return { windows: out, error: null }
}

function rangeError(label: string, raw: string, min: number, max: number | null, int: boolean): string | null {
  const n = Number(raw)
  if (raw.trim() === '' || !Number.isFinite(n)) return `${label}: enter a number`
  if (int && !Number.isInteger(n)) return `${label}: whole number`
  if (n < min) return `${label}: ${n} is below ${min}`
  if (max != null && n > max) return `${label}: ${n} is above ${max}`
  return null
}

export type FormErrors = Partial<Record<keyof SearchForm, string>>

export function validateForm(f: SearchForm): FormErrors {
  const e: FormErrors = {}
  if (!f.asset.trim()) e.asset = 'enter an asset'
  if (f.metrics.length === 0) e.metrics = 'pick at least one metric'
  if (f.metrics.length > 40) e.metrics = 'at most 40 metrics'
  if (!Number.isInteger(f.horizonDays) || f.horizonDays < 1 || f.horizonDays > 180) e.horizonDays = 'horizon: 1–180 days'
  if (f.transforms.length === 0) e.transforms = 'pick at least one transform'
  const w = parseWindows(f.windows)
  if (w.error) e.windows = w.error
  const checks: Array<[keyof SearchForm, string, number, number | null, boolean]> = [
    ['labelQuantile', 'label quantile', 0.05, 0.5, false],
    ['folds', 'folds', 2, 6, true],
    ['minSupport', 'min support', 5, null, true],
    ['slippageBps', 'slippage', 0, 200, false],
    ['topK', 'top k', 1, 50, true],
  ]
  for (const [key, label, min, max, int] of checks) {
    const msg = rangeError(label, f[key] as string, min, max, int)
    if (msg) e[key] = msg
  }
  if (f.seed.trim() !== '' && !Number.isInteger(Number(f.seed))) e.seed = 'seed: whole number'
  const date = /^\d{4}-\d{2}-\d{2}$/
  if (f.from && !date.test(f.from)) e.from = 'from: YYYY-MM-DD'
  if (f.to && !date.test(f.to)) e.to = 'to: YYYY-MM-DD'
  if (f.from && f.to && date.test(f.from) && date.test(f.to) && f.from >= f.to) e.to = 'to: must be after from'
  return e
}

/** Form → lab_search args. Assumes validateForm passed. */
export function buildSearchArgs(f: SearchForm): SearchConfigInput {
  const args: SearchConfigInput = {
    asset: f.asset.trim().toUpperCase(),
    direction: f.direction,
    metrics: [...f.metrics],
    horizonDays: f.horizonDays,
    objective: f.objective,
    trials: f.trials,
    transforms: [...f.transforms],
    windows: parseWindows(f.windows).windows ?? [7, 30, 90],
    labelQuantile: Number(f.labelQuantile),
    folds: Number(f.folds),
    minSupport: Number(f.minSupport),
    slippageBps: Number(f.slippageBps),
    topK: Number(f.topK),
  }
  if (f.from) args.from = f.from
  if (f.to) args.to = f.to
  if (f.seed.trim() !== '') args.seed = Number(f.seed)
  return args
}

/** A stored run's config back into the form (RUNS → /lab/runs/:id). */
export function formFromConfig(c: Partial<SearchConfig>): SearchForm {
  const d = DEFAULT_FORM
  return {
    asset: c.asset ?? d.asset,
    direction: c.direction ?? d.direction,
    metrics: c.metrics ? [...c.metrics] : [],
    horizonDays: c.horizonDays ?? d.horizonDays,
    objective: c.objective ?? d.objective,
    trials: c.trials ?? d.trials,
    transforms: c.transforms ? [...c.transforms] : [...d.transforms],
    windows: c.windows ? c.windows.join(', ') : d.windows,
    labelQuantile: c.labelQuantile != null ? String(c.labelQuantile) : d.labelQuantile,
    folds: c.folds != null ? String(c.folds) : d.folds,
    minSupport: c.minSupport != null ? String(c.minSupport) : d.minSupport,
    slippageBps: c.slippageBps != null ? String(c.slippageBps) : d.slippageBps,
    topK: c.topK != null ? String(c.topK) : d.topK,
    from: c.from ?? '',
    to: c.to ?? '',
    seed: c.seed != null ? String(c.seed) : d.seed,
  }
}

/** Amber dot on ADVANCED when any advanced value differs from default. */
export function advancedDiffers(f: SearchForm): boolean {
  return ADVANCED_KEYS.some((k) => {
    if (k === 'transforms') {
      return f.transforms.length !== DEFAULT_FORM.transforms.length || !DEFAULT_FORM.transforms.every((t) => f.transforms.includes(t))
    }
    if (k === 'windows') {
      const a = parseWindows(f.windows).windows
      return !a || a.join(',') !== '7,30,90'
    }
    return String(f[k]).trim() !== String(DEFAULT_FORM[k])
  })
}

/** Rough engine feature count for the busy line: per metric, raw once + every other transform at every window. */
export function estimateFeatures(metrics: number, transforms: readonly Transform[], windows: number): number {
  const windowed = transforms.filter((t) => t !== 'raw').length
  return metrics * ((transforms.includes('raw') ? 1 : 0) + windowed * windows)
}

export const EFFORT_TRIALS = [20, 40, 100, 200] as const
const EFFORT_DEFAULT_HINT: Record<number, string> = { 20: '~10 s', 40: '~25 s', 100: '~60 s', 200: '~2 min' }

export function fmtApproxDuration(ms: number): string {
  const s = ms / 1000
  if (s < 90) return `~${Math.max(1, Math.round(s))} s`
  return `~${Math.round(s / 60)} min`
}

/** EFFORT hint per trial count: from the last known ms/trial when there is one, else the spec defaults. */
export function effortHint(trials: number, msPerTrial: number | null): string {
  if (msPerTrial != null && Number.isFinite(msPerTrial) && msPerTrial > 0) return fmtApproxDuration(msPerTrial * trials)
  return EFFORT_DEFAULT_HINT[trials] ?? '—'
}

/** `field` from a 400 (`metrics.3`, `windows`) → the form key it outlines. */
export function fieldRoot(field: string | undefined | null): string | null {
  if (!field) return null
  return field.split(/[.[]/)[0] || null
}

/** Config summary: `BTC · LONG · 14D · 6 METRICS · 40 TRIALS`. */
export function configSummary(c: { asset: string; direction: Direction; horizonDays: number; metrics: readonly string[]; trials: number }): string {
  return `${c.asset.toUpperCase()} · ${c.direction.toUpperCase()} · ${c.horizonDays}D · ${c.metrics.length} METRICS · ${c.trials} TRIALS`
}

export function benchmarkLabel(rule: Pick<Rule, 'asset' | 'direction'>): string {
  return `${rule.direction === 'short' ? 'SHORT' : 'HOLD'} ${rule.asset.toUpperCase()}`
}

/** Metrics shown for the typed asset: global ones, or asset ones whose `assets[]` lists it (any case). */
export function metricAvailable(m: MetricDef, asset: string): boolean {
  if (!m.assets || m.assets.length === 0) return true
  const a = asset.trim().toLowerCase()
  if (!a) return true
  return m.assets.some((x) => x.toLowerCase() === a)
}

/** LIVE column cell: `—` unsaved, `n/a — 12 live days` under 30 days. */
export function liveCell(live: PerfStats | null | undefined, catalogued: boolean): { stats: PerfStats | null; text: string | null; title: string } {
  if (!catalogued) return { stats: null, text: '—', title: 'not catalogued' }
  if (!live) return { stats: null, text: '—', title: 'no live days yet' }
  if (live.days < 30) return { stats: null, text: `n/a — ${live.days} live days`, title: `${live.days} live days` }
  return { stats: live, text: null, title: `${live.from} → ${live.to}` }
}

/** RUNS `ASSET·DIR·HZN` cell (§4.4): `BTC·L·14D`. */
export function runKey(r: Pick<RunSummary, 'asset' | 'direction' | 'horizonDays'>): string {
  return `${r.asset.toUpperCase()}·${r.direction === 'short' ? 'S' : 'L'}·${r.horizonDays}D`
}

export function runStatus(r: Pick<RunSummary, 'status'>): { label: 'OK' | 'FAILED'; tone: 'gray' | 'red' } {
  return r.status === 'error' ? { label: 'FAILED', tone: 'red' } : { label: 'OK', tone: 'gray' }
}

// ------------------------------------------------------------------ robustness (§10.9 DSR, verdict, untested, folds)

/** A window's Sharpe, or null when the window is missing or `untested` (no trade: its 0 is not a result). */
export function sharpeOf(s: PerfStats | null | undefined): number | null {
  if (!s || s.untested === true || !Number.isFinite(s.sharpe)) return null
  return s.sharpe
}

/** One Sharpe cell: signed + toned; `untested` (no trade in the window) or `—` (no window) in secondary. */
export function sharpeCell(s: PerfStats | null | undefined): { text: string; tone: string; title?: string } {
  if (!s) return { text: '—', tone: 'text-text-secondary', title: 'not enough history' }
  if (s.untested === true) return { text: 'untested', tone: 'text-text-secondary', title: 'no trade in this window — not tested, not "no edge"' }
  return { text: fmtSigned(s.sharpe), tone: signTone(s.sharpe) }
}

/** Server verdict (LAB.md); the UI renders it, never computes it. */
export type Verdict = NonNullable<RuleEvaluation['verdict']>

const VERDICT_BADGE: Record<VerdictLevel, { label: string; tone: 'green' | 'amber' | 'red' | 'gray' }> = {
  robust: { label: 'ROBUST', tone: 'green' },
  candidate: { label: 'CANDIDATE', tone: 'amber' },
  fragile: { label: 'FRAGILE', tone: 'red' },
  weak: { label: 'WEAK', tone: 'gray' },
  fails_holdout: { label: 'FAILS HOLDOUT', tone: 'red' },
}

/** The evaluation's server verdict when well-formed; null when absent (older runs) or unknown. */
export function verdictOf(ev: object | null | undefined): Verdict | null {
  const v = (ev as { verdict?: unknown } | null | undefined)?.verdict as Partial<Verdict> | null | undefined
  if (!v || typeof v !== 'object' || typeof v.level !== 'string' || !(v.level in VERDICT_BADGE)) return null
  const reasons = Array.isArray(v.reasons) ? v.reasons.filter((r): r is string => typeof r === 'string') : []
  return { level: v.level as VerdictLevel, reasons }
}

export function verdictBadge(level: VerdictLevel): { label: string; tone: 'green' | 'amber' | 'red' | 'gray' } {
  return VERDICT_BADGE[level]
}

/** N of the deflated Sharpe for a search: effective (decorrelated) trials when reported, else variants scored. */
export function effectiveTrials(result: Pick<SearchResult, 'variantsScored' | 'effectiveTrials'> | null | undefined): number | null {
  const n = result?.effectiveTrials ?? result?.variantsScored ?? null
  return n != null && Number.isFinite(n) && n > 0 ? n : null
}

/** `N≈312` (≥ 1000 → `N≈1.2k`). */
export function fmtTrialsN(n: number): string {
  return `N≈${n >= 1000 ? `${Number((n / 1000).toPrecision(2))}k` : Math.round(n)}`
}

export function fmtDsr(dsr: number | null | undefined): string {
  return dsr == null || !Number.isFinite(dsr) ? '—' : dsr.toFixed(2)
}

/**
 * The save bar's deflated-Sharpe cut-off. Mirrors MIN_DEFLATED_SHARPE in
 * src/server/lab/engine/verdict.ts (a value import would pull zod and the
 * server types module into the bundle); lab.test.ts asserts they are equal.
 */
export const MIN_DEFLATED_SHARPE = 0.9

/** DSR ≥ MIN_DEFLATED_SHARPE is the save bar (green); below 0.5 the edge is as likely luck as not (amber). */
export function dsrTone(dsr: number | null | undefined): string {
  if (dsr == null || !Number.isFinite(dsr)) return 'text-text-secondary'
  if (dsr >= MIN_DEFLATED_SHARPE) return 'text-green'
  if (dsr < 0.5) return 'text-amber'
  return 'text-text-primary'
}

/**
 * N context of a deflated Sharpe. `n`: the N it was deflated against (1 =
 * undeflated), null/undefined when unknown. `assumedOne`: the search's N is
 * unknown and the server deflated against its default N = 1.
 */
export type DsrN = { n: number | null | undefined; assumedOne?: boolean }

export function dsrTitle(n: number | null | undefined, opts: { assumedOne?: boolean } = {}): string {
  const bar = `(≥ ${MIN_DEFLATED_SHARPE.toFixed(2)} to save)`
  if (opts.assumedOne) return `deflated against N=1 (undeflated): the search's N is unknown (its run is no longer stored), so this reads higher than a deflated DSR ${bar}`
  if (n == null || !Number.isFinite(n)) return `deflated Sharpe, N unknown (the search's trial count is not available) ${bar}`
  if (n <= 1) return `deflated against N=1 (undeflated): no search to deflate for, so this reads higher than a searched rule's DSR ${bar}`
  return `deflated Sharpe: probability the walk-forward Sharpe beats what the best of ${fmtTrialsN(n).slice(2)} effective trials would reach by luck ${bar}`
}

/**
 * One DSR cell. `—` without walk-forward; `—` "undefined" when the server
 * returns null beside a walk-forward (the moments make the statistic
 * undefined); else 2 decimals, toned against the save bar, title naming N.
 */
export function dsrCell(ev: { deflatedSharpe?: number | null; walkForward?: PerfStats | null }, ctx: DsrN): { text: string; tone: string; title: string } {
  const dsr = ev.deflatedSharpe
  if (ev.walkForward == null) return { text: '—', tone: 'text-text-secondary', title: 'no walk-forward — not enough history' }
  if (dsr === undefined) return { text: '—', tone: 'text-text-secondary', title: 'not reported (evaluation stored before the deflated Sharpe existed)' }
  if (dsr === null || !Number.isFinite(dsr)) return { text: '—', tone: 'text-text-secondary', title: 'undefined (extreme skew/kurtosis)' }
  return { text: fmtDsr(dsr), tone: dsrTone(dsr), title: dsrTitle(ctx.n, { assumedOne: ctx.assumedOne }) }
}

/**
 * Per-fold walk-forward Sharpes → bar geometry for a w×h sparkline (zero line
 * at the middle when signs mix). Every fold keeps its slot; a null fold
 * (`untested`, no trade) is a gap.
 */
export function foldBars(folds: readonly (number | null)[], w: number, h: number): { zeroY: number; bars: Array<{ i: number; x: number; y: number; width: number; height: number; positive: boolean }> } {
  const vals = folds.filter((f): f is number => f != null && Number.isFinite(f))
  if (vals.length === 0) return { zeroY: h, bars: [] }
  const max = Math.max(0, ...vals)
  const min = Math.min(0, ...vals)
  const span = max - min || 1
  const zeroY = (max / span) * h
  const slot = w / folds.length
  const width = Math.max(1, slot - 2)
  const bars: Array<{ i: number; x: number; y: number; width: number; height: number; positive: boolean }> = []
  folds.forEach((v, i) => {
    if (v == null || !Number.isFinite(v)) return
    const len = (Math.abs(v) / span) * h
    bars.push({ i, x: i * slot + (slot - width) / 2, y: v >= 0 ? zeroY - len : zeroY, width, height: Math.max(len, 0.5), positive: v >= 0 })
  })
  return { zeroY, bars }
}

/** One fold's printed value: signed + toned, `untested` (secondary) for a null fold. */
export function foldCell(f: number | null | undefined): { text: string; tone: string; title?: string } {
  if (f == null || !Number.isFinite(f)) return { text: 'untested', tone: 'text-text-secondary', title: 'no trade in this fold — not tested, not "no edge"' }
  return { text: fmtSigned(f), tone: signTone(f) }
}

/** Equity for a log Y axis: non-positive multiples (a wiped-out short) become null — a gap, not a crash. */
export function logSafeEquity<P extends { strategy: number; benchmark: number }>(equity: readonly P[]): Array<Omit<P, 'strategy' | 'benchmark'> & { strategy: number | null; benchmark: number | null }> {
  const pos = (v: number) => (Number.isFinite(v) && v > 0 ? v : null)
  return equity.map((p) => ({ ...p, strategy: pos(p.strategy), benchmark: pos(p.benchmark) }))
}

/**
 * N of the search behind a drill: the run's effective trials; 1 for a rule
 * saved without a run (its evaluation was never deflated); null when unknown
 * (run pruned, failed or older than the count); undefined while the run is
 * still loading. `runId` is `?run=` or the catalogue entry's run.
 */
export function drillTrialsN(o: { runId: string | null; run: Pick<StoredRun, 'result'> | null | undefined; runSettled: boolean }): number | null | undefined {
  if (o.runId == null) return 1
  if (o.run) return effectiveTrials(o.run.result)
  return o.runSettled ? null : undefined
}

/**
 * lab_evaluate_rule args for the drill's fresh evaluation: the search's N
 * (`trials`), so the server's deflated Sharpe and verdict are deflated for
 * the search that found the rule, and a sensitivity grid, so the verdict's
 * stability check runs. Unknown N → no `trials` (server default N = 1).
 */
export function drillEvaluateArgs(rule: Rule, o: { trialsN: number | null; slippageBps?: number; windows?: number[] }): {
  rule: Rule
  includeEquity: true
  sensitivity: true
  trials?: number
  slippageBps?: number
  windows?: number[]
} {
  return {
    rule,
    includeEquity: true,
    sensitivity: true,
    ...(o.trialsN != null && o.trialsN > 1 ? { trials: o.trialsN } : {}),
    ...(o.slippageBps != null ? { slippageBps: o.slippageBps } : {}),
    ...(o.windows ? { windows: o.windows } : {}),
  }
}

/** DSR N context of the fresh evaluation (computed with `trials` = the search's N, or the server's N = 1 when unknown). */
export function freshDsrN(trialsN: number | null): DsrN {
  return trialsN == null ? { n: 1, assumedOne: true } : { n: trialsN }
}

/** The newest run to restore on an empty SEARCH tab (lab_list_runs is newest first). */
export function latestRunId(runs: readonly Pick<RunSummary, 'id'>[] | null | undefined): string | null {
  return runs?.[0]?.id ?? null
}
