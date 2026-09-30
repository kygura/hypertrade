import { expect, test } from 'bun:test'
import { fmtPct, fmtUsd } from './format.js'

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

// Unit contract pin (see comment above fmtPct in format.ts): input is a
// FRACTION, not a pre-scaled percent. 0.021 is "2.10%", not "0.02%" — the
// silent-100x-bug case this test exists to catch.
test('fmtPct takes a fraction, not a pre-scaled percent', () => {
  expect(fmtPct(0.021)).toBe('2.10%')
  expect(fmtPct(-0.0005, { decimals: 4, sign: true })).toBe('-0.0500%')
})
