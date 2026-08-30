import { expect, test } from 'bun:test'
import { fmtUsd } from './format'

test('fmtUsd compact scales K/M/B/T', () => {
  expect(fmtUsd(1_500, { compact: true })).toBe('$1.50K')
  expect(fmtUsd(2_500_000, { compact: true })).toBe('$2.50M')
  expect(fmtUsd(3_500_000_000, { compact: true })).toBe('$3.50B')
  expect(fmtUsd(4_500_000_000_000, { compact: true })).toBe('$4.50T')
})

test('fmtUsd compact handles sign and sub-K values', () => {
  expect(fmtUsd(-2_500_000_000, { compact: true })).toBe('-$2.50B')
  expect(fmtUsd(42, { compact: true })).toBe('$42.00')
})
