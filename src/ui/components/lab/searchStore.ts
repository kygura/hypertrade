import { useSyncExternalStore } from 'react'
import { ApiError, NetworkError } from '../../lib/api'
import {
  buildSearchArgs,
  DEFAULT_FORM,
  errorText,
  estimateFeatures,
  fieldRoot,
  formFromConfig,
  isAbort,
  lab,
  latestRunId,
  parseWindows,
  readLocalRaw,
  writeLocal,
  type SearchConfig,
  type SearchForm,
  type SearchResult,
} from '../../lib/lab'

// SEARCH tab state, kept outside React so it survives tab switches and the
// round trip through a rule drill (the form, the in-flight search, the last
// results). One search at a time; STOP WAITING aborts only the client's wait
// — the server run still finishes and lands in RUNS (§10.9 busy state).

export interface Landed {
  runId: string | null
  createdAt: string
  config: SearchConfig | null
  result: SearchResult | null
  /** A failed stored run's verbatim error. */
  error: string | null
}

export interface SearchStoreState {
  form: SearchForm
  busy: { startedAt: number; trials: number; features: number } | null
  landed: Landed | null
  /** lab_search failure: verbatim message, the field a 400 named, or no network. */
  error: { message: string; field: string | null; offline: boolean } | null
  /** Loading a stored run (/lab/runs/:id or the last run on /lab/search). */
  runLoad: { id: string; loading: boolean; error: string | null; offline: boolean } | null
  /** Mobile: form collapsed to the summary bar once a run lands. */
  collapsed: boolean
  /** The one polite status line (`18 rules · 40 of 40 trials`). */
  announce: string
  /** Bumps when a search lands — drives the one-time scrollIntoView. */
  landSeq: number
  /** The rule whose drill you came back from (selected card). */
  selectedRuleId: string | null
}

const LAST_RUN_KEY = 'lab.lastRun'
const MS_PER_TRIAL_KEY = 'lab.msPerTrial'

let state: SearchStoreState = {
  form: DEFAULT_FORM,
  busy: null,
  landed: null,
  error: null,
  runLoad: null,
  collapsed: false,
  announce: '',
  landSeq: 0,
  selectedRuleId: null,
}
const listeners = new Set<() => void>()
let controller: AbortController | null = null

function set(patch: Partial<SearchStoreState>) {
  state = { ...state, ...patch }
  for (const l of listeners) l()
}

function subscribe(l: () => void) {
  listeners.add(l)
  return () => listeners.delete(l)
}

export function useSearchStore(): SearchStoreState {
  const snap = () => state
  return useSyncExternalStore(subscribe, snap, snap)
}

export const searchStore = {
  get: () => state,
  setForm(patch: Partial<SearchForm>) {
    set({ form: { ...state.form, ...patch } })
  },
  setCollapsed(collapsed: boolean) {
    set({ collapsed })
  },
  select(ruleId: string | null) {
    set({ selectedRuleId: ruleId })
  },
  clearError() {
    if (state.error) set({ error: null })
  },

  async run(): Promise<void> {
    const form = state.form
    const args = buildSearchArgs(form)
    const ctrl = new AbortController()
    controller?.abort()
    controller = ctrl
    set({
      busy: {
        startedAt: Date.now(),
        trials: form.trials,
        features: estimateFeatures(form.metrics.length, form.transforms, parseWindows(form.windows).windows?.length ?? 3),
      },
      error: null,
      announce: '',
    })
    try {
      const { runId, result } = await lab.search(args, ctrl.signal)
      if (controller !== ctrl) return
      set({
        busy: null,
        landed: { runId, createdAt: new Date().toISOString(), config: result.config, result, error: null },
        collapsed: true,
        announce: `${result.rules.length} rules · ${result.trialsRun} of ${result.config.trials} trials`,
        landSeq: state.landSeq + 1,
        selectedRuleId: null,
      })
      if (runId) writeLocal(LAST_RUN_KEY, runId)
      if (result.trialsRun > 0 && result.durationMs > 0) writeLocal(MS_PER_TRIAL_KEY, String(result.durationMs / result.trialsRun))
    } catch (err) {
      if (controller !== ctrl || isAbort(err)) return
      if (err instanceof ApiError && err.status === 401) return
      set({
        busy: null,
        error: {
          message: errorText(err),
          field: err instanceof ApiError ? fieldRoot(err.field) : null,
          offline: err instanceof NetworkError,
        },
      })
    } finally {
      if (controller === ctrl) controller = null
    }
  },

  stopWaiting() {
    controller?.abort()
    controller = null
    set({ busy: null })
  },

  /** Load a stored run into the form + results. `quiet`: a failure leaves the tab empty (last-run restore). */
  async loadRun(id: string, quiet = false): Promise<void> {
    if (state.busy) return
    set({ runLoad: { id, loading: true, error: null, offline: false } })
    try {
      const run = await lab.getRun(id)
      if (state.runLoad?.id !== id) return
      set({
        runLoad: null,
        form: formFromConfig(run.config),
        landed: { runId: run.id, createdAt: run.createdAt, config: run.config, result: run.result, error: run.status === 'error' ? (run.error ?? 'run failed') : null },
        error: null,
        collapsed: run.status !== 'error',
      })
    } catch (err) {
      if (state.runLoad?.id !== id) return
      if (err instanceof ApiError && err.status === 401) return
      set({ runLoad: quiet ? null : { id, loading: false, error: errorText(err), offline: err instanceof NetworkError } })
    }
  },

  /**
   * Nothing in memory (reload, new device): this browser's last run, else the
   * newest stored run (lab_list_runs limit 1 → lab_get_run). Quiet: a failure
   * leaves the tab on its empty state.
   */
  async loadLatest(): Promise<void> {
    const last = readLocalRaw(LAST_RUN_KEY)
    if (last) {
      await searchStore.loadRun(last, true)
      if (state.landed || state.busy) return
    }
    set({ runLoad: { id: '', loading: true, error: null, offline: false } })
    let id: string | null = null
    try {
      id = latestRunId(await lab.listRuns(1))
    } catch {
      // quiet
    }
    if (state.runLoad?.id !== '') return
    set({ runLoad: null })
    if (id && id !== last && !state.landed && !state.busy) await searchStore.loadRun(id, true)
  },

  lastRunId: () => readLocalRaw(LAST_RUN_KEY),
  msPerTrial(): number | null {
    const v = Number(readLocalRaw(MS_PER_TRIAL_KEY))
    return Number.isFinite(v) && v > 0 ? v : null
  },
}
