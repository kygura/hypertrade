// UI-side shapes for the branch views. The result shapes are the shared SimResult
// (src/shared/intent.ts, mirrors server/sim/engine.ts + montecarlo.ts); the names
// below are aliases of its parts. BranchConfig lives in shared/types.ts.
import type { SimResult } from '../../../shared/intent'
import type { BranchConfig } from '../../../shared/types'

export type EquityPoint = SimResult['equity'][number]
export type BranchStats = SimResult['stats']
export type MonteCarloResult = NonNullable<SimResult['montecarlo']>
export type BranchResult = SimResult

// GET /api/branches and GET /api/branches/:id both left-join branch_results,
// so every branch row carries its cached result (possibly null).
export interface Branch {
  id: string
  name: string
  config: BranchConfig
  createdAt: string
  updatedAt: string
  result: BranchResult | null
}

export type BranchDetail = Branch
