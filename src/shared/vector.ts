// BTC Vector screen contract (ported from hl-cycles Phase 4, model in hl-cycles docs/MODEL.md §8).
// GET /api/vector returns VectorResponse. All timestamps are epoch ms UTC.

export type RegimeState = 'strong_risk_off' | 'mild_risk_off' | 'mild_risk_on' | 'strong_risk_on'
export type InputUnit = 'pct' | 'ratio' | 'usd' | 'btc' | 'index' | 'count' | 'z'
export type LevelStatus = 'holding' | 'lost' | 'contested'
export type GaugeKey = 'risk' | 'momentum' | 'fundamentals' | 'flows'
export type GaugeReading = {
  now: number | null
  lastWeek: number | null
  avg52w: number | null
  scale: { min: number; max: number }
}
export type LensInput = { key: string; label: string; value: number | null; pct: number | null; asOf: number | null; unit: InputUnit }
export type Lens = {
  key: string
  label: string
  score: number | null
  band: string | null
  d7: number | null
  d30: number | null
  standalone: boolean
  inputs: LensInput[]
}
export type Level = { key: string; label: string; value: number | null; distancePct: number | null; status: LevelStatus | null; proxy: boolean }
export type Flip = { t: number; from: RegimeState; to: RegimeState; price: number }
export type WocPhase = 'strong_uptrend' | 'capitulation' | 'bear' | 'transition'
export type VectorResponse = {
  asOf: number | null
  oldestInputAsOf: number | null
  stale: boolean
  /** Latest BTC price the levels are measured against (hl-cycles read it from /api/overview). */
  price: number | null
  regime: {
    state: RegimeState | null
    since: number | null
    allocation: number | null
    riskOff: number | null
    momentum: number | null
    flows: number | null
    htfNote: string | null
    conditions: { key: string; label: string; on: boolean; value: number | null; asOf: number | null }[]
  }
  flips: Flip[]
  history: { t: number; price: number; state: RegimeState | null; riskOff: number | null; momentum: number | null }[]
  compass: {
    headline: { score: number | null; band: string | null; d7: number | null; d30: number | null }
    lenses: Lens[]
    history: {
      t: number
      headline: number | null
      macro: number | null
      flows: number | null
      behaviour: number | null
      fundamentals: number | null
      cycle: number | null
      derivatives: number | null
      rotation: number | null
    }[]
  }
  levels: Level[]
  wocPhase: WocPhase | null
  brief: { sentences: string[]; confirm: string | null; invalidate: string | null }
  gauges: Record<GaugeKey, GaugeReading>
  macro: {
    dollarVs200d: number | null
    us10y: number | null
    us2y: number | null
    fedFundsUpper: number | null
    curve: number | null
    spxCorr30d: number | null
    asOf: number | null
  }
  sources: Record<string, { lastOk: number | null; lastError: string | null }>
}
