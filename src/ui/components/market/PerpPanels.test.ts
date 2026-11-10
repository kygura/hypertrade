import { describe, expect, test } from 'bun:test'
import type { AssetCtx } from '../../../shared/types'
import { meanFunding, statsFromLive, venueSentence } from './PerpPanels'

const HOUR = 3_600_000

describe('venueSentence', () => {
  test('normalises the 8h Binance rate before comparing', () => {
    // HL 0.00005/h = 43.8% APR; Binance 0.0001/8h = 10.95% APR.
    const s = venueSentence([
      { venue: 'HlPerp', rate: 0.00005, intervalHours: 1, nextFundingTime: null },
      { venue: 'BinPerp', rate: 0.0001, intervalHours: 8, nextFundingTime: null },
    ])
    expect(s).toBe('HL predicted funding is 33 pts APR above Binance (HL +44%, Binance +11%).')
  })
  test('below, Bybit fallback, match, and missing venues', () => {
    expect(
      venueSentence([
        { venue: 'HlPerp', rate: -0.00002, intervalHours: 1, nextFundingTime: null },
        { venue: 'BybitPerp', rate: 0.0001, intervalHours: 8, nextFundingTime: null },
      ]),
    ).toBe('HL predicted funding is 29 pts APR below Bybit (HL -18%, Bybit +11%).')
    expect(
      venueSentence([
        { venue: 'HlPerp', rate: 0.0000125, intervalHours: 1, nextFundingTime: null },
        { venue: 'BinPerp', rate: 0.0001, intervalHours: 8, nextFundingTime: null },
      ]),
    ).toBe('HL and Binance predicted funding match: +11% APR.')
    expect(venueSentence([{ venue: 'HlPerp', rate: 0.0001, intervalHours: 1, nextFundingTime: null }])).toBeNull()
  })
})

describe('meanFunding', () => {
  test('averages settlements inside the window only', () => {
    const now = 100 * HOUR
    const pts = [
      { t: 99 * HOUR, rate: 0.0002, premium: 0 },
      { t: 90 * HOUR, rate: 0.0001, premium: 0 },
      { t: 10 * HOUR, rate: 1, premium: 0 },
    ]
    expect(meanFunding(pts, now, 24)).toBeCloseTo(0.00015, 10)
    expect(meanFunding(pts, now, 0.5)).toBeNull()
  })
})

describe('statsFromLive', () => {
  const c: AssetCtx = {
    name: 'kPEPE', szDecimals: 0, markPx: 2, oraclePx: 2, midPx: 2, dayNtlVlm: 10, prevDayPx: 1, openInterest: 5,
    funding: 0.0001, premium: 0.001, dayChange: 1, isDelisted: false, impactBidPx: null, impactAskPx: null,
  }
  const u = { ctxs: [c], predicted: new Map([['kPEPE', [{ venue: 'HlPerp', rate: 0.0001, intervalHours: 1, nextFundingTime: null }]]]), atCap: ['kPEPE'], updatedAt: 0 }
  test('maps the live ctx to the /api/perp shape, case-insensitive, history fields null', () => {
    const s = statsFromLive('KPEPE', u)!
    expect(s.coin).toBe('kPEPE')
    expect(s.ctx?.openInterestUsd).toBe(10)
    expect(s.atOiCap).toBe(true)
    expect(s.predicted).toHaveLength(1)
    expect(s.fundingAvg).toEqual({ h24: null, d7: null, d30: null })
    expect(statsFromLive('NOPE', u)).toBeNull()
  })
})
