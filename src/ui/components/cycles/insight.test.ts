import { describe, expect, test } from 'bun:test'
import type { BullEpisode, CycleForecast, Readiness } from '../../../shared/cycleForecast'
import { cycleInsight } from './insight'

const D = 86_400_000
const TOP = Date.UTC(2025, 9, 6)
const ep = (topT: number): BullEpisode => ({ breakout: { t: topT - 700 * D, price: 1 }, start: topT - 500 * D, end: topT - 10 * D, startPrice: 2, top: { t: topT, price: 4 }, low: null, lowConfirmed: false })
const readiness: Readiness = {
  phase: 'markdown', phaseSince: Date.UTC(2026, 1, 3), price: 80_000, ath: { t: TOP, price: 124_000 }, toAth: 0.55, daysSinceTop: 402, drawdown: -0.3548,
  low: null, lowDepth: null, bounce: null, priorBearDepths: [], elapsed: 0.612,
}
type In = Parameters<typeof cycleInsight>[0]
const f = (over: Partial<In> = {}): In => ({ kind: 'breakout', readiness, episodes: [ep(TOP - 2800 * D), ep(TOP - 1400 * D), ep(TOP)], onset: null, ...over })

describe('cycleInsight', () => {
  test('phase, time and distance from the top, share of the median gap with n', () => {
    expect(cycleInsight(f(), 'BTC')).toBe(
      'The model reads BTC in markdown since 2026-02-03; 402 days since the Oct 2025 cycle top, price 35.5% below it; that is 61% of the median gap from a top to the next run start (n 2 past gaps).',
    )
  })

  test('adds the core window when there is an estimate; drops the gap share during a run', () => {
    const onset: CycleForecast['onset'] = { min: 0, p25: Date.UTC(2027, 3, 1), median: 0, p75: Date.UTC(2027, 10, 1), max: 0 }
    expect(cycleInsight(f({ onset, kind: 'euphoria' }), 'ETH')).toContain('; past gaps put the next euphoria onset between Apr 2027 and Nov 2027 (middle half of the estimates).')
    const inRun = cycleInsight(f({ readiness: { ...readiness, elapsed: null, drawdown: 0.02, phase: null } }), 'BTC')
    expect(inRun).toBe('402 days since the Oct 2025 cycle top, price 2.0% above it.')
  })

  test('null before any bull run', () => {
    expect(cycleInsight(f({ episodes: [] }), 'BTC')).toBeNull()
    expect(cycleInsight(f({ readiness: null }), 'BTC')).toBeNull()
  })
})
