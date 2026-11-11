import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { VectorResponse } from '../../../shared/vector'
import { bandIndex, DAY_MS, gaugeAngle, GAUGE_ZONES, isVectorStale, overflowMark, priceDividerIndex, zoneFor } from './scales'
import { LevelsTable } from './LevelsTable'
import { VectorView } from './VectorView'

const NOW = Date.UTC(2026, 10, 11)

describe('vector scales', () => {
  test('gauge angle: min left (π), max right (0), clamped past the domain', () => {
    expect(gaugeAngle(0, 0, 100)).toBeCloseTo(Math.PI)
    expect(gaugeAngle(100, 0, 100)).toBeCloseTo(0)
    expect(gaugeAngle(0, -100, 100)).toBeCloseTo(Math.PI / 2)
    expect(gaugeAngle(250, 0, 100)).toBeCloseTo(0)
    expect(gaugeAngle(-5, 0, 100)).toBeCloseTo(Math.PI)
    expect(gaugeAngle(5, 3, 3)).toBeCloseTo(Math.PI / 2)
    expect(overflowMark(120, 0, 100)).toBe('›')
    expect(overflowMark(-1, 0, 100)).toBe('‹')
    expect(overflowMark(50, 0, 100)).toBe('')
  })

  test('zones: upper bound inclusive, past the top falls in the last zone', () => {
    expect(zoneFor(GAUGE_ZONES.risk, 25).word).toBe('low risk')
    expect(zoneFor(GAUGE_ZONES.risk, 25.1).word).toBe('elevated')
    expect(zoneFor(GAUGE_ZONES.risk, 140).word).toBe('high risk')
    expect(zoneFor(GAUGE_ZONES.momentum, -3).word).toBe('bearish')
    expect(zoneFor(GAUGE_ZONES.momentum, 3).word).toBe('bullish')
  })

  test('band index fixed at 20/40/60/80, 100 is the top band', () => {
    expect([0, 19.9, 20, 59, 80, 100].map(bandIndex)).toEqual([1, 1, 2, 3, 5, 5])
  })

  test('stale when the server says so or asOf is older than three days', () => {
    expect(isVectorStale({ stale: true, asOf: NOW }, NOW)).toBe(true)
    expect(isVectorStale({ stale: false, asOf: NOW - 3 * DAY_MS }, NOW)).toBe(false)
    expect(isVectorStale({ stale: false, asOf: NOW - 3 * DAY_MS - 1 }, NOW)).toBe(true)
    expect(isVectorStale({ stale: false, asOf: null }, NOW)).toBe(false)
  })

  test('price divider sits above the first level below price', () => {
    expect(priceDividerIndex([96_700, 86_000, 77_200, 73_300], 83_675)).toBe(2)
    expect(priceDividerIndex([96_700, null], 120_000)).toBe(0)
    expect(priceDividerIndex([96_700, 86_000], 50_000)).toBe(-1)
    expect(priceDividerIndex([96_700], null)).toBe(-1)
  })
})

const reading = (now: number | null) => ({ now, lastWeek: 30, avg52w: 40, scale: { min: 0, max: 100 } })

function fixture(over: Partial<VectorResponse> = {}): VectorResponse {
  return {
    asOf: NOW,
    oldestInputAsOf: NOW - DAY_MS,
    stale: false,
    price: 83_675,
    regime: {
      state: 'mild_risk_on',
      since: NOW - 41 * DAY_MS,
      allocation: 60,
      riskOff: 0.3,
      momentum: 12,
      flows: 55,
      htfNote: 'HTF phase reads DISTRIBUTION — the cycle frame disagrees with the regime.',
      conditions: [{ key: 'c1', label: 'Drawdown over 20%', on: true, value: 0.21, asOf: NOW }],
    },
    flips: [{ t: NOW - 41 * DAY_MS, from: 'mild_risk_off', to: 'mild_risk_on', price: 70_000 }],
    history: [{ t: NOW, price: 83_675, state: 'mild_risk_on', riskOff: 0.3, momentum: 12 }],
    compass: {
      headline: { score: 62, band: 'Healthy', d7: 4, d30: -12 },
      lenses: [
        { key: 'flows', label: 'Capital Flows', score: 31, band: 'Light', d7: 4, d30: -12, standalone: false, inputs: [] },
        { key: 'cycle', label: 'Cycle Position', score: 44, band: 'Mid', d7: 0, d30: 1, standalone: true, inputs: [] },
      ],
      history: [],
    },
    levels: [
      { key: 'sth', label: 'STH cost basis', value: 73_300, distancePct: -12.4, status: 'holding', proxy: false },
      { key: 'etf', label: 'ETF cost basis', value: 86_000, distancePct: 2.8, status: 'lost', proxy: true },
    ],
    wocPhase: 'strong_uptrend',
    brief: { sentences: ['Price holds above the STH cost basis.'], confirm: 'a daily close above $86.0K', invalidate: null },
    gauges: { risk: reading(30), momentum: { ...reading(12), scale: { min: -100, max: 100 } }, fundamentals: reading(70), flows: reading(31) },
    macro: { dollarVs200d: 1.8, us10y: 4.29, us2y: 3.89, fedFundsUpper: 4, curve: 0.4, spxCorr30d: -0.42, asOf: NOW },
    sources: { fred: { lastOk: NOW - 3_600_000, lastError: null }, glassnode: { lastOk: null, lastError: 'HTTP 503' } },
    ...over,
  }
}

describe('VectorView', () => {
  test('renders every panel with the API words and numbers', () => {
    const html = renderToStaticMarkup(<VectorView vector={fixture()} now={NOW} />)
    for (const s of [
      'MILD RISK-ON',
      '60% BTC',
      'day 41',
      'DISTRIBUTION',
      'a daily close above $86.0K',
      'Capital Flows',
      'Standalone',
      'BRIEF · STRONG UPTREND',
      'price $83,675',
      '1 ok',
      '1 failing',
      '−0.42',
    ]) {
      expect(html).toContain(s)
    }
    // flows gauge prints the lens band, not its fallback zone word
    expect(html).toContain('Light')
    expect(html).not.toContain('inputs stale')
  })

  test('stale payload shows the strip; null regime prints a dash and its reason', () => {
    const v = fixture({ asOf: NOW - 4 * DAY_MS })
    v.regime = { ...v.regime, state: null, allocation: null }
    const html = renderToStaticMarkup(<VectorView vector={v} now={NOW} />)
    expect(html).toContain('inputs stale')
    expect(html).toContain('insufficient history')
  })

  test('levels ladder: high to low, price divider between, distance signed', () => {
    const html = renderToStaticMarkup(<LevelsTable levels={fixture().levels} price={80_000} />)
    const etf = html.indexOf('ETF cost basis')
    const div = html.indexOf('price $80,000')
    const sth = html.indexOf('STH cost basis')
    expect(etf).toBeGreaterThan(-1)
    expect(etf < div && div < sth).toBe(true)
    expect(html).toContain('+2.8%')
    expect(html).toContain('−12.4%')
    expect(html).toContain('2 of 2 levels available')
  })
})
