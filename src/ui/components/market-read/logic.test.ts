import { describe, expect, test } from 'bun:test'
import type { AssetCtx } from '../../../shared/types'
import { BASELINE_APR, ageText, cexApr, changeColor, floorUniverse, fundingBoard, heatColor, heatGrid, movers, pct0, premiumBoard } from './logic'

const HOUR = 3_600_000
const ctx = (name: string, o: Partial<AssetCtx> = {}): AssetCtx => ({
  name,
  szDecimals: 0,
  markPx: 1,
  oraclePx: 1,
  midPx: 1,
  dayNtlVlm: 5e6,
  prevDayPx: 1,
  openInterest: 5e6,
  funding: 0,
  premium: 0,
  dayChange: 0,
  isDelisted: false,
  ...o,
})

describe('floorUniverse', () => {
  test('drops delisted coins and coins under the $1M OI or volume floors', () => {
    const u = floorUniverse([ctx('A'), ctx('B', { isDelisted: true }), ctx('C', { openInterest: 9e5 }), ctx('D', { dayNtlVlm: 9e5 })])
    expect(u.map((c) => c.name)).toEqual(['A'])
  })
})

describe('cexApr', () => {
  test('normalises an 8h Binance rate to APR and prefers Binance over Bybit', () => {
    const r = cexApr([
      { venue: 'BybitPerp', rate: 0.001, intervalHours: 8, nextFundingTime: null },
      { venue: 'BinPerp', rate: 0.0001, intervalHours: 8, nextFundingTime: null },
    ])
    expect(r?.venue).toBe('Binance')
    expect(r?.aprPct).toBeCloseTo(10.95, 2)
    expect(cexApr(undefined)).toBeNull()
  })
})

describe('boards', () => {
  const u = Array.from({ length: 12 }, (_, i) => ctx(`C${i}`, { funding: (i - 6) / 1e5, premium: (i - 3) / 1e4, dayChange: (i - 5) / 100, dayNtlVlm: (i + 1) * 1e6 }))
  test('hot and cold funding do not overlap and are ordered outward', () => {
    const { hot, cold } = fundingBoard(u, new Map())
    expect(hot.map((r) => r.coin)).toEqual(['C11', 'C10', 'C9', 'C8', 'C7'])
    expect(cold.map((r) => r.coin)).toEqual(['C0', 'C1', 'C2', 'C3', 'C4'])
    expect(fundingBoard(u.slice(0, 6), new Map()).cold.map((r) => r.coin)).toEqual(['C0'])
  })
  test('premium board ranks by absolute bp', () => {
    expect(premiumBoard(u, 2).map((r) => [r.coin, Math.round(r.bp)])).toEqual([
      ['C11', 8],
      ['C10', 7],
    ])
  })
  test('movers split by sign; volume is a multiple of the top-50 median', () => {
    const m = movers(u, 3)
    expect(m.up.map((r) => r.coin)).toEqual(['C11', 'C10', 'C9'])
    expect(m.down.map((r) => r.coin)).toEqual(['C0', 'C1', 'C2'])
    // median of 1..12 M = 6.5M
    expect(m.up[0]!.volX).toBeCloseTo(12 / 6.5, 5)
  })
})

describe('heatGrid', () => {
  test('buckets settlements into hourly columns, rows hottest first', () => {
    const now = 100 * HOUR + 5 * 60_000
    const data = new Map([
      ['A', [{ t: 98 * HOUR + 1000, rate: 0.0001, premium: 0 }, { t: 10 * HOUR, rate: 1, premium: 0 }]],
      ['B', [{ t: 100 * HOUR, rate: -0.0001, premium: 0 }]],
    ])
    const g = heatGrid([ctx('A', { funding: 0 }), ctx('B', { funding: 0.0001 }), ctx('C')], data, now, 3)
    expect(g.cols).toEqual([98 * HOUR, 99 * HOUR, 100 * HOUR])
    expect(g.rows.map((r) => r.coin)).toEqual(['B', 'A'])
    expect(g.rows[1]!.cells[0]).toBeCloseTo(87.6, 5)
    expect(g.rows[1]!.cells.slice(1)).toEqual([null, null])
    expect(g.rows[0]!.cells[2]).toBeCloseTo(-87.6, 5)
  })
})

describe('colours and words', () => {
  test('heat is warm for longs paying, cool for shorts paying, neutral near zero', () => {
    expect(heatColor(80)).toContain('--color-amber')
    expect(heatColor(-80)).toContain('--color-info')
    expect(heatColor(0)).toContain('--color-info')
    expect(heatColor(11)).toBe('var(--color-elevated)')
    expect(heatColor(null)).toBe('transparent')
    expect(heatColor(500)).toBe(heatColor(BASELINE_APR + 60))
  })
  test('change colour caps at ±10%', () => {
    expect(changeColor(25)).toBe(changeColor(10))
    expect(changeColor(-3)).toContain('--color-red')
  })
  test('age and percent text', () => {
    expect(ageText(null, 0)).toBe('connecting')
    expect(ageText(1000, 13_000)).toBe('updated 12s ago')
    expect(ageText(0, 600_000)).toBe('updated 10m ago')
    expect(pct0(41.6)).toBe('+42%')
    expect(pct0(-0.2)).toBe('0%')
  })
})
