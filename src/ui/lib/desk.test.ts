import { describe, expect, test } from 'bun:test'
import { openRiskUsd as governorOpenRiskUsd } from '../../server/desk/governor'
import { deskTakeaway, openRiskUsd, type AccountState, type Position } from './desk'

const pos = (p: Partial<Position> & Pick<Position, 'coin'>): Position => ({
  side: 'long',
  size: 1,
  entryPx: 100,
  markPx: 100,
  stopPx: 95,
  tpPx: null,
  unrealizedPnl: 0,
  notionalUsd: 100,
  ...p,
})
const book = (positions: Position[], over: Partial<AccountState> = {}): AccountState => ({ venue: 'paper', equityUsd: 10_000, dayPnlUsd: 0, positions, available: true, ...over })
const LIMITS = { maxPositions: 4, maxGrossLeverage: 2, maxOpenRiskPct: 2, dailyLossLimitPct: 2, minConfidence: 'medium' }

describe('openRiskUsd', () => {
  test('matches the governor for long, short, past-stop and unprotected positions', () => {
    const cases = [
      pos({ coin: 'BTC', size: 0.05, markPx: 60_000, stopPx: 57_000, notionalUsd: 3000 }),
      pos({ coin: 'ETH', side: 'short', size: 2, markPx: 3000, stopPx: 3150, notionalUsd: 6000 }),
      pos({ coin: 'SOL', size: 10, markPx: 90, stopPx: 95, notionalUsd: 900 }),
      pos({ coin: 'HYPE', size: 10, markPx: 40, stopPx: null, notionalUsd: 400 }),
    ]
    for (const c of cases) expect(openRiskUsd(c)).toBe(governorOpenRiskUsd(c))
  })
})

describe('deskTakeaway', () => {
  test('flat book: no positions, pending count', () => {
    expect(deskTakeaway(book([]), [{ status: 'pending' }, { status: 'executed' }], LIMITS)).toBe('No open positions. 1 proposal waiting for approval.')
  })

  test('sums gross and stop risk against equity with the governor limits', () => {
    const line = deskTakeaway(
      book([
        pos({ coin: 'BTC', size: 0.05, markPx: 60_000, stopPx: 57_000, notionalUsd: 3000 }),
        pos({ coin: 'ETH', side: 'short', size: 0.5, markPx: 2000, stopPx: 2100, notionalUsd: 1000 }),
      ]),
      [],
      LIMITS,
    )
    expect(line).toBe(
      '2 open positions (limit 4), $4,000.00 gross notional, 0.4x equity (limit 2x). Open stop risk $200.00, 2% of equity (limit 2%). Largest: BTC, 75% of gross. 0 proposals waiting for approval.',
    )
  })

  test('counts positions without a stop and states a day loss against its limit', () => {
    const line = deskTakeaway(book([pos({ coin: 'SOL', stopPx: null })], { dayPnlUsd: -150 }), [], LIMITS)!
    expect(line).toContain('1 open position (limit 4)')
    expect(line).toContain('Open stop risk $100.00, 1% of equity')
    expect(line).toContain('1 position has no stop.')
    expect(line).toContain('Day loss 1.5% of equity (new entries are blocked at 2%).')
    expect(line).not.toContain('Largest')
  })

  test('works without limits and returns null when the account was not read', () => {
    expect(deskTakeaway(book([pos({ coin: 'SOL' })]))).toBe('1 open position, $100.00 gross notional, 0.01x equity. Open stop risk $5.00, 0.1% of equity. 0 proposals waiting for approval.')
    expect(deskTakeaway(book([], { available: false, note: 'upstream error' }))).toBeNull()
  })
})
