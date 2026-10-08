import type { SimBranchOutcome, SimIntent } from '../../shared/intent'
import { ApiError, NetworkError } from './api'

// Client for /api/analyst (SPEC.md "Analyst"). The query endpoint is a POST
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

const REDIRECT_KEY = 'ht_redirect_to'

async function failFrom(res: Response): Promise<never> {
  if (res.status === 401) {
    sessionStorage.setItem(REDIRECT_KEY, location.pathname)
    location.href = '/login'
    throw new ApiError('unauthorized', 401)
  }
  const body = (await res.json().catch(() => null)) as { error?: string } | null
  throw new ApiError(body?.error ?? res.statusText, res.status)
}

export async function getAnalystStatus(): Promise<AnalystStatus> {
  let res: Response
  try {
    res = await fetch('/api/analyst/status', { credentials: 'include' })
  } catch (err) {
    throw new NetworkError(err instanceof Error ? err.message : 'network unreachable')
  }
  if (!res.ok) return failFrom(res)
  return (await res.json()) as AnalystStatus
}

/** Always resolves — the catalog is 200 even fully unconfigured (both
 * providers `available: false`), so the selector can explain what to set. */
export async function getAnalystModels(): Promise<AnalystCatalog> {
  let res: Response
  try {
    res = await fetch('/api/analyst/models', { credentials: 'include' })
  } catch (err) {
    throw new NetworkError(err instanceof Error ? err.message : 'network unreachable')
  }
  if (!res.ok) return failFrom(res)
  return (await res.json()) as AnalystCatalog
}

/** Splits an SSE text buffer into complete frames; returns [frames, rest]. */
export function splitFrames(buf: string): [Array<{ event: string; data: string }>, string] {
  const frames: Array<{ event: string; data: string }> = []
  let rest = buf.replace(/\r\n/g, '\n')
  let idx: number
  while ((idx = rest.indexOf('\n\n')) >= 0) {
    const raw = rest.slice(0, idx)
    rest = rest.slice(idx + 2)
    let event = 'message'
    const data: string[] = []
    for (const line of raw.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
    }
    if (data.length) frames.push({ event, data: data.join('\n') })
  }
  return [frames, rest]
}

/** POST /api/analyst/query body; `mode` is only sent for sim (ask stays byte-identical). */
export function queryBody(question: string, history: HistoryTurn[], choice?: AnalystChoice, mode: AnalystMode = 'ask') {
  return { question, history, ...choice, ...(mode === 'sim' ? { mode } : {}) }
}

/** Evenly thins a series to at most `max` points, always keeping the first and last. */
export function downsample<T>(pts: T[], max = 200): T[] {
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
  let res: Response
  try {
    res = await fetch('/api/analyst/query', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(queryBody(question, history, choice, mode)),
      signal,
    })
  } catch (err) {
    if (signal?.aborted) return
    throw new NetworkError(err instanceof Error ? err.message : 'network unreachable')
  }
  if (!res.ok || !res.body) return failFrom(res)

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const [frames, rest] = splitFrames(buf)
      buf = rest
      for (const f of frames) {
        try {
          onEvent({ type: f.event, ...JSON.parse(f.data) } as AnalystStreamEvent)
        } catch {
          // A malformed frame is skipped; the done event still arrives.
        }
      }
    }
  } catch (err) {
    if (signal?.aborted) return
    throw new NetworkError(err instanceof Error ? err.message : 'stream interrupted')
  }
}
