import { AgentRecordSchema, AgentStatsResponseSchema, TriageResponseSchema, type AgentRecord, type AgentStatsResponse, type TriageResponse } from '../../../shared/agentRecords'
import { MoveDetailSchema, MoveRowSchema, MovesResponseSchema, type MoveDetail, type MoveRow, type MovesResponse } from '../../../shared/moves'

// Fixtures for the MOVES tests. Every builder parses its result with the shared zod schema, so a contract drift
// fails here first. Test-only: nothing in the app imports this file.

export const ASOF = '2026-11-11T14:00:00.000Z'
export const NOW = Date.parse('2026-11-11T14:20:00.000Z')

const attribution = (over: Record<string, unknown> = {}) => ({
  window: '24h', from: '2026-11-10T14:00:00.000Z', to: ASOF, hours: 24,
  totalPct: 9.4, btcPct: 1.1, ethPct: 0.4, sectorPct: 1.7, residualPct: 6.2,
  residualFlowPct: 2.1, residualNewsPct: 0.9, residualOtherPct: 3.2, flowHours: 3, newsHours: 2,
  residualZ: 3.1, sigma1hPct: 0.41, r2: 0.62,
  estimation: { from: '2026-11-03T14:00:00.000Z', to: '2026-11-10T14:00:00.000Z', n: 168 },
  betas: [
    { factor: 'BTC', beta: 1.3, contributionPct: 1.1, n: 168, reason: null },
    { factor: 'ETH', beta: 0.5, contributionPct: 0.4, n: 168, reason: null },
    { factor: 'SECTOR', beta: 0.8, contributionPct: 1.7, n: 168, reason: null },
  ],
  ...over,
})

const check = (key: string, side: string, value: number | null, threshold: number, met: boolean | null) => ({ key, side, value, threshold, met })

export function row(coin = 'HYPE', over: Record<string, unknown> = {}): MoveRow {
  return MoveRowSchema.parse({
    coin, sector: { id: 'defi', label: 'DeFi' }, mark: 42.18, dayNtlVlm: 310_000_000,
    attribution: attribution(), attributionReason: null,
    positioning: {
      fundingHourly: 0.00004, fundingAprPct: 35, fundingZ: 2.3, fundingN: 336, premiumBps: 6.1, oiUsd: 410_000_000,
      oiChg24hPct: 4.2, oiChg72hPct: 12.5, oiN: 72, oiToVolume: 1.32,
      checks: [
        check('funding_z', 'long', 2.3, 2, true), check('funding_apr', 'long', 35, 25, true), check('oi_build', 'long', 12.5, 10, true), check('premium', 'long', 6.1, 5, null),
        check('funding_z', 'short', 2.3, 2, false), check('funding_apr', 'short', 35, 25, false), check('oi_build', 'short', 12.5, 10, false), check('premium', 'short', 6.1, 5, null),
      ],
      longMet: 3, shortMet: 0, of: 3,
    },
    liq: {
      state: { state: 'ok', reason: null },
      nearestLong: { priceLo: 39.5, priceHi: 40.1, distancePct: 5.6, notionalUsd: 6_100_000 },
      nearestShort: { priceLo: 44.9, priceHi: 45.3, distancePct: 6.7, notionalUsd: 3_000_000 },
      sigma24hPct: 4.4, longSigmas: 1.3, shortSigmas: 1.5, coverageRatio: 0.6,
    },
    attention: {
      state: { state: 'ok', reason: null }, news24h: 4, news72h: 6, newsDailyMean7d: 1.5, newsRatio: 2.7,
      mentions24h: 820, mentionsChg24hPct: 55, mentionsAsOf: '2026-11-11T13:00:00.000Z', sectorId: 'defi', sectorStage: 'crowded',
    },
    setups: [
      {
        kind: 'fade', side: 'long', met: 2, of: 3, definitionId: 'funding_fade',
        checks: [
          { key: 'crowd', label: 'crowding met', value: 3, threshold: '≥ 3', met: true },
          { key: 'attention', label: 'attention saturated', value: 'stage crowded', threshold: 'crowded or fading', met: true },
          { key: 'liq', label: 'cluster within 1.0σ', value: 1.3, threshold: '≤ 1.0σ', met: false },
        ],
      },
      { kind: 'enter', side: 'long', met: 1, of: 3, definitionId: null, checks: [{ key: 'attn', label: 'attention rising', value: 2.7, threshold: '≥ 2×', met: true }] },
    ],
    opportunityId: null,
    ...over,
  })
}

export const nullRow = (coin = 'NEWC'): MoveRow =>
  row(coin, { attribution: null, attributionReason: 'needs 120 of 168 hourly bars before the window — has 74', sector: null })

const layer = (state: 'ok' | 'partial' | 'unavailable' = 'ok', reason: string | null = null) => ({ state, reason })

export function movesResponse(over: Record<string, unknown> = {}): MovesResponse {
  return MovesResponseSchema.parse({
    state: 'ok', reason: null, asOf: ASOF, computedAt: '2026-11-11T14:02:00.000Z', window: '24h', progress: null,
    universe: { coins: 3, dropped: [{ coin: 'OLD', reason: 'delisted' }] },
    sectorsAsOf: '2026-11-02T00:00:00.000Z',
    factors: [
      { id: 'BTC', label: 'BTC', pct: -1.8, n: 1 },
      { id: 'ETH', label: 'ETH', pct: -2.4, n: 1 },
      { id: 'ETHX', label: 'ETH ex-BTC', pct: -0.7, n: 1 },
      { id: 'sector:defi', label: 'DeFi ex-majors', pct: 3.1, n: 9 },
    ],
    layers: { beta: layer(), flow: layer('partial', 'OI snapshots cover 31h of 48h'), attention: layer('unavailable', 'needs a database'), liq: layer(), agents: layer() },
    rows: [row('HYPE'), row('SOL', { attribution: attribution({ residualPct: -2.5, residualZ: -1.2, totalPct: -3.0 }) }), nullRow('NEWC')],
    ...over,
  })
}

export function record(over: Record<string, unknown> = {}): AgentRecord {
  return AgentRecordSchema.parse({
    id: 'rec-1', coin: 'HYPE', createdAt: '2026-11-11T13:00:00.000Z', trigger: 'triage',
    inputs: { window: '24h', residualPct: 6.2, residualZ: 3.1, totalPct: 9.4, markAtCreate: 42.18, btcAtCreate: 98000, asOf: ASOF },
    claim: 'Buyback announcement reported 2h before the move.', assets: ['HYPE'], direction: 'long', horizonHours: 24, layer: 'narrative',
    falsifier: { level: 39.9, side: 'below', text: 'price trades below 39.9' },
    sources: [{ url: 'https://example.com/hype-buyback', ts: '2026-11-11T11:00:00.000Z', title: 'HYPE buyback', observed: true }],
    status: 'open', grade: null, model: 'claude-x', promptVersion: 'moves-agent-v1', dropped: 0,
    ...over,
  })
}

export function triage(over: Record<string, unknown> = {}): TriageResponse {
  return TriageResponseSchema.parse({
    state: 'ok', reason: null, day: '2026-11-11', budget: 8, surfaced: 6, overBudget: 0, watched: 38, agentRuns: 3, agentCap: 6, agentBlockedReason: null,
    items: [
      { id: 't1', day: '2026-11-11', coin: 'HYPE', reason: 'residual +6.2% · z 3.1 · 24h · no news in window', score: 1.24, residualZ: 3.1, surfacedAt: '2026-11-11T13:30:00.000Z', dismissedAt: null, recordId: 'rec-1', record: record() },
      { id: 't2', day: '2026-11-11', coin: 'SOL', reason: 'FADE 3/3 · crowd long 3/4', score: 1, residualZ: null, surfacedAt: '2026-11-11T13:00:00.000Z', dismissedAt: null, recordId: null, record: null },
      { id: 't3', day: '2026-11-11', coin: 'DOGE', reason: 'residual −4.0% · z −2.7 · 24h', score: 1.1, residualZ: -2.7, surfacedAt: '2026-11-11T12:00:00.000Z', dismissedAt: '2026-11-11T12:30:00.000Z', recordId: null, record: null },
    ],
    ...over,
  })
}

export function detail(over: Record<string, unknown> = {}): MoveDetail {
  const base = movesResponse()
  return MoveDetailSchema.parse({
    ...row('HYPE'),
    state: 'ok', reason: null, asOf: ASOF, window: '24h', layers: base.layers,
    series: [0, 1, 2, 3].map((i) => ({ t: Date.parse('2026-11-11T10:00:00.000Z') + i * 3_600_000, cumTotalPct: i * 2, cumFittedPct: i * 0.8, cumResidualPct: i * 1.2, flowHour: i === 2, newsHour: i === 3 })),
    headlines: [{ title: 'HYPE announces buyback', firstSeen: '2026-11-11T11:00:00.000Z', url: 'https://example.com/n1', assets: ['HYPE'] }],
    record: record(),
    ...over,
  })
}

export const stats = (over: Record<string, unknown> = {}): AgentStatsResponse =>
  AgentStatsResponseSchema.parse({
    total: 30, graded: 23, noCause: 4,
    byHorizon: [{ key: '24h', n: 23, clusters: 14, meanRelPct: 0.4, ci95: [-0.6, 1.4], hitRate: 0.52 }],
    byLayer: [],
    ...over,
  })
