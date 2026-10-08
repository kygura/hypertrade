import { expect, test } from 'bun:test'
import { allocationSummary, hasPerpLeg } from './format'

test('perp legs and list summary', () => {
  expect(hasPerpLeg([{ coin: 'BTC', weightPct: 100 }])).toBe(false)
  expect(hasPerpLeg([{ coin: 'BTC', weightPct: 100, leverage: 2 }])).toBe(true)
  expect(hasPerpLeg([{ coin: 'BTC', weightPct: 100, side: 'short' }])).toBe(true)
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
