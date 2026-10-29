import type { SimBranchOutcome, SimIntent } from '../../shared/intent'
import { api } from './api'
import { splitFrames, streamSse } from './sse'

export { splitFrames }

// Client for /api/analyst (docs/SPEC.md "Analyst"). The query endpoint is a POST
// that answers with text/event-stream, so EventSource (GET-only) does not
// fit; this reads the fetch body and splits SSE frames by hand. 401 follows
// api.ts's redirect-to-login rule; 503/502 surface as ApiError so the page
// can render its offline states.

export interface AnalystCitation {
  url: string
  title: string | null
  cited_text?: string
}

export interface AnalystUsage {
  input_tokens: number
  output_tokens: number
}

export type AnalystStreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'reasoning'; delta: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown; server: boolean }
  | { type: 'tool_result'; id: string; name: string; ok: boolean; summary: string }
  | { type: 'sim_result'; id: string; intent: SimIntent; branches: SimBranchOutcome[] }
  | { type: 'citations'; citations: AnalystCitation[] }
  | { type: 'error'; error: string }
  | { type: 'done'; usage: AnalystUsage; model: string; provider: string; label?: string; rounds: number; stop: string; effort?: AnalystEffort }

export type SimResultEvent = Extract<AnalystStreamEvent, { type: 'sim_result' }>
export type AnalystMode = 'ask' | 'sim'

export interface AnalystStatus {
  configured: boolean
  provider: string
  label?: string
  model: string
  web_search: boolean
  tools: Array<{ name: string; available: boolean; note?: string }>
}

export interface HistoryTurn {
  role: 'user' | 'assistant'
  content: string
}

// Model/provider catalog (src/server/llm/catalog.ts) — GET /api/analyst/models,
// used by ModelSelector (src/ui/components/analyst/ModelSelector.tsx).
/** anthropic, a vendor preset (openai, google, xai, deepseek, moonshot, qwen, openrouter) or openai-compatible. */
export type AnalystProviderId = string
export type AnalystEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type AnalystTier = 'frontier' | 'balanced' | 'fast'

export interface AnalystCatalogModel {
  id: string
  label: string
  note: string
  tier: AnalystTier
  effort: boolean
  /** Levels this model accepts, weakest first (all five when absent). */
  efforts?: AnalystEffort[]
  defaultEffort?: AnalystEffort
}

export interface AnalystCatalogProvider {
  id: AnalystProviderId
  label: string
  /** Short line under the name ("Kimi K3, K2.6"). */
  blurb?: string
  /** Provider-hosted web search (Anthropic). */
  webSearch?: boolean
  available: boolean
  reason?: string
  models: AnalystCatalogModel[]
}

export interface AnalystCatalog {
  default: { provider: AnalystProviderId; model: string }
  providers: AnalystCatalogProvider[]
}

export interface AnalystChoice {
  provider: AnalystProviderId
  model: string
  effort?: AnalystEffort
}

export const getAnalystStatus = () => api.get<AnalystStatus>('/analyst/status')

/** Always resolves — the catalog is 200 even fully unconfigured (both
 * providers `available: false`), so the selector can explain what to set. */
export const getAnalystModels = () => api.get<AnalystCatalog>('/analyst/models')

/** POST /api/analyst/query body; `mode` is only sent for sim (ask stays byte-identical). */
export function queryBody(question: string, history: HistoryTurn[], choice?: AnalystChoice, mode: AnalystMode = 'ask') {
  return { question, history, ...choice, ...(mode === 'sim' ? { mode } : {}) }
}

/** Evenly thins a series to at most 200 points, always keeping the first and last. */
export function downsample<T>(pts: T[]): T[] {
  const max = 200
  if (pts.length <= max) return pts
  return Array.from({ length: max }, (_, i) => pts[Math.round((i * (pts.length - 1)) / (max - 1))]!)
}

/** Copy of a sim_result with every stored series capped for localStorage. */
export function compactSim(s: SimResultEvent): SimResultEvent {
  return {
    ...s,
    branches: s.branches.map((b) => {
      const r = b.result
      if (!r) return b
      const mc = r.montecarlo
      return {
        ...b,
        result: {
          ...r,
          equity: downsample(r.equity),
          benchmarks: { btc: downsample(r.benchmarks.btc), usdc: downsample(r.benchmarks.usdc) },
          ...(mc ? { montecarlo: { median: downsample(mc.median), p10: downsample(mc.p10), p90: downsample(mc.p90) } } : {}),
        },
      }
    }),
  }
}

/**
 * Streams one question. Calls onEvent for every server event in order and
 * resolves when the stream ends. Throws ApiError (503/502/4xx before the
 * stream starts) or NetworkError; an AbortSignal stops it quietly.
 */
export async function streamAnalyst(
  question: string,
  history: HistoryTurn[],
  onEvent: (e: AnalystStreamEvent) => void,
  signal?: AbortSignal,
  choice?: AnalystChoice,
  mode: AnalystMode = 'ask',
): Promise<void> {
  return streamSse<AnalystStreamEvent>('/api/analyst/query', queryBody(question, history, choice, mode), onEvent, signal)
}
