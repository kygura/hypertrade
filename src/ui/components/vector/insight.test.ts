import { describe, expect, test } from 'bun:test'
import type { VectorResponse } from '../../../shared/vector'
import { regimeInsight } from './insight'

const DAY = 86_400_000
const NOW = Date.UTC(2026, 10, 11)
type In = Parameters<typeof regimeInsight>[0]

const cond = (key: string, on: boolean) => ({ key, label: key, on, value: null, asOf: NOW })
const level = (key: string, distancePct: number | null): VectorResponse['levels'][number] => ({ key, label: key, value: 1, distancePct, status: null, proxy: false })

const base: In = {
  asOf: NOW,
  regime: { state: 'mild_risk_off', since: NOW - 12 * DAY, allocation: 33, riskOff: 0.333, momentum: -8, flows: 1, htfNote: null, conditions: [cond('a', true), cond('b', true), cond('c', false)] },
  levels: [level('sth_cost_basis', 3), level('sma200', -8.04)],
  compass: { headline: { score: 37.6, band: 'Defensive', d7: 1, d30: -12.2 }, lenses: [], history: [] },
}

describe('regimeInsight', () => {
  test('states the regime, its age, active conditions, the 200-day distance and the headline', () => {
    expect(regimeInsight(base)).toBe(
      'The model reads mild risk-off for 12 days; 2 of 3 stress conditions are active; price is 8.0% below the 200-day average; compass headline 38 (Defensive), −12 points over 30 days.',
    )
  })

  test('leaves out what the payload does not carry', () => {
    const v: In = { ...base, regime: { ...base.regime, state: 'strong_risk_on', since: NOW - DAY, conditions: [] }, levels: [level('sma200', 4.26)], compass: { ...base.compass, headline: { score: null, band: null, d7: null, d30: null } } }
    expect(regimeInsight(v)).toBe('The model reads strong risk-on for 1 day; price is 4.3% above the 200-day average.')
    expect(regimeInsight({ ...v, asOf: null, levels: [] })).toBe('The model reads strong risk-on.')
  })

  test('null without a regime reading', () => {
    expect(regimeInsight({ ...base, regime: { ...base.regime, state: null } })).toBeNull()
  })
})
