import { describe, expect, test } from 'bun:test'
import { fundingCrowded, rowsFromCtxs } from './Markets'
import type { AssetCtx } from '../../shared/types'

describe('fundingCrowded', () => {
  // HL funding is an hourly fraction: 50% APR is 0.5 / 8760 ≈ 0.0000571 per hour.
  test('fires at |APR| >= 50, both sides', () => {
    expect(fundingCrowded(0.5 / 8760)).toBe(true)
    expect(fundingCrowded(-0.6 / 8760)).toBe(true)
    expect(fundingCrowded(0.49 / 8760)).toBe(false)
    expect(fundingCrowded(0)).toBe(false)
  })

  test('a typical hot hourly rate (0.01%/h, ~88% APR) fires; the old 0.1%/h line never did', () => {
    expect(fundingCrowded(0.0001)).toBe(true)
    expect(fundingCrowded(0.0000125)).toBe(false) // HL's baseline 11% APR
  })
})

describe('rowsFromCtxs', () => {
  const ctx = (name: string, oi: number, px: number, extra: Partial<AssetCtx> = {}): AssetCtx => ({
    name, szDecimals: 0, markPx: px, oraclePx: px, midPx: px, dayNtlVlm: 1, prevDayPx: px, openInterest: oi,
    funding: 0, premium: 0, dayChange: 0, isDelisted: false, impactBidPx: null, impactAskPx: null, ...extra,
  })
  test('drops delisted coins, sorts by OI in USD', () => {
    const rows = rowsFromCtxs([ctx('A', 10, 1), ctx('B', 1, 100), ctx('C', 1e9, 1, { isDelisted: true })])
    expect(rows.map((r) => r.coin)).toEqual(['B', 'A'])
    expect(rows[0]!.openInterestUsd).toBe(100)
    expect(rows[0]!.dex).toBe('')
  })
})
