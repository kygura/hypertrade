import { expect, test } from 'bun:test'
import { branchLine } from './format'
import { allocationSummary } from './format'
import { isPerp } from '../../../shared/schemas'

test('perp legs and list summary', () => {
  expect(isPerp({})).toBe(false)
  expect(isPerp({ leverage: 2 })).toBe(true)
  expect(isPerp({ side: 'short' })).toBe(true)
  const allocs = [
    { coin: 'SOL', weightPct: 30, leverage: 3 },
    { coin: 'BTC', weightPct: 30, side: 'short' as const },
    { coin: 'ETH', weightPct: 20, side: 'short' as const, leverage: 2 },
    { coin: 'USDC', weightPct: 20 },
  ]
  expect(allocationSummary(allocs, [{ coin: 'ETH', amountUsd: 5, every: 'weekly' }])).toBe(
    '30 SOL 3× / 30 BTC SHORT / 20 ETH SHORT 2× / 20 USDC + DCA',
  )
})

test('branchLine: capital, dates, return, deepest fall and the BTC comparison as facts', () => {
  const t0 = Date.parse('2025-11-12T00:00:00Z')
  const t1 = Date.parse('2026-11-11T00:00:00Z')
  const result = {
    equity: [{ ts: t0, value: 10000 }, { ts: t1, value: 12340 }],
    benchmarks: { btc: [{ ts: t0, value: 10000 }, { ts: t1, value: 11000 }] },
    stats: { finalValue: 12340, maxDrawdownPct: 18.24, vsBtcPct: 12.18 },
  }
  expect(branchLine(result, 10000)).toBe(
    '$10,000 on 2025-11-12 became $12,340 by 2026-11-11 (+23.4% over 364 days). Deepest fall from a peak: 18.2%. Holding BTC over the same days ended at $11,000: the branch ended 12.2% above that.',
  )
  expect(branchLine({ ...result, stats: { finalValue: 9000, maxDrawdownPct: 30, vsBtcPct: -18.18 } }, 10000)).toContain('(−10.0% over 364 days). Deepest fall from a peak: 30.0%. Holding BTC over the same days ended at $11,000: the branch ended 18.2% below that.')
  expect(branchLine({ ...result, equity: [] }, 10000)).toBeNull()
})
