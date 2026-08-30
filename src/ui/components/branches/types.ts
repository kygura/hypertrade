// UI-side shapes for the branch views. Mirrors src/server/db.ts `Branch`
// row and src/server/sim/engine.ts + montecarlo.ts result shapes — those
// aren't in shared/types.ts because they wrap a DB row / server-internal
// result, not the shared jsonb config schema (BranchConfig already lives
// there and is reused as-is).
import type { BranchConfig } from '../../../shared/types'

export interface Branch {
  id: string
  name: string
  config: BranchConfig
  createdAt: string
  updatedAt: string
}

export interface EquityPoint {
  ts: number
  value: number
}

export interface BranchStats {
  finalValue: number
  cagrPct: number
  maxDrawdownPct: number
  vsBtcPct: number
  vsUsdcPct: number
}

export interface MonteCarloResult {
  median: EquityPoint[]
  p10: EquityPoint[]
  p90: EquityPoint[]
}

export interface BranchResult {
  equity: EquityPoint[]
  benchmarks: { btc: EquityPoint[]; usdc: EquityPoint[] }
  stats: BranchStats
  montecarlo?: MonteCarloResult
}

// GET /api/branches/:id shape (branch row + cached result, possibly null).
export type BranchDetail = Branch & { result: BranchResult | null }
