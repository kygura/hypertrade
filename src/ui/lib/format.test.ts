import { expect, test } from 'bun:test'
import {
  fmtAge, fmtDur, fmtPx, fmtSigned, fmtTs, fmtTsSec, fmtUsd, fmtUsdCompact, fmtUsdSigned, fmtUtcStamp, signClass,
} from './format'

test('fmtUtcStamp / fmtTs / fmtTsSec: UTC stamps with invalid-date and empty guards', () => {
  expect(fmtUtcStamp('2026-09-23T08:05:42Z')).toBe('2026-09-23 08:05 UTC')
  expect(fmtUtcStamp('garbage')).toBe('garbage')
  expect(fmtTs('2026-09-23T08:05:42Z')).toBe('2026-09-23 08:05 UTC')
  expect(fmtTs(null)).toBe('—')
  expect(fmtTs('')).toBe('—')
  expect(fmtTs('nope')).toBe('nope')
  expect(fmtTsSec('2026-09-23T08:05:42Z')).toBe('2026-09-23 08:05:42 UTC')
  expect(fmtTsSec(undefined)).toBe('—')
})

test('fmtDur', () => {
  for (const [sec, out] of [[-5, '0S'], [42.9, '42S'], [60, '1M'], [3599, '59M'], [3600, '1H'], [47 * 3600, '47H'], [48 * 3600, '2D']] as const) {
    expect(fmtDur(sec)).toBe(out)
  }
})

test('fmtAge: words with AGO, dash for empty, input back for invalid', () => {
  const now = Date.parse('2026-09-23T12:00:00Z')
  expect(fmtAge('2026-09-23T11:57:00Z', now)).toBe('3M AGO')
  expect(fmtAge('2026-09-23T07:00:00Z', now)).toBe('5H AGO')
  expect(fmtAge('2026-09-23T11:59:59Z', now)).toBe('1S AGO')
  expect(fmtAge(null, now)).toBe('—')
  expect(fmtAge('bad', now)).toBe('bad')
})

test('fmtSigned: typographic minus, null guard, zero unsigned', () => {
  const rows: [number | null | undefined, string, number, string][] = [
    [38, 'bp', 0, '+38bp'],
    [-12, 'bp', 0, '−12bp'],
    [0, 'bp', 0, '0bp'],
    [-0.2, 'bp', 0, '0bp'],
    [-5.4, '%', 1, '−5.4%'],
    [null, 'bp', 0, '—'],
    [undefined, '%', 1, '—'],
    [NaN, '%', 1, '—'],
  ]
  for (const [n, unit, dp, out] of rows) expect(fmtSigned(n, unit, dp)).toBe(out)
})

test('USD and price formatters', () => {
  expect(fmtUsd(1234.5)).toBe('$1,234.50')
  expect(fmtUsd(-3)).toBe('−$3.00')
  expect(fmtUsdSigned(12.345)).toBe('+$12.35')
  expect(fmtUsdSigned(-1500)).toBe('−$1,500')
  expect(fmtUsdSigned(0)).toBe('$0')
  expect(fmtUsdSigned(null)).toBe('—')
  expect(fmtUsdCompact(1_250_000)).toBe('$1.3M')
  expect(fmtUsdCompact(-2500)).toBe('-$2.5K')
  expect(fmtPx(64321.77)).toBe('64,321.8')
  expect(fmtPx(12.34567)).toBe('12.346')
  expect(fmtPx(0.012346)).toBe('0.01235')
  expect(fmtPx(null)).toBe('—')
  expect(fmtPx(Infinity)).toBe('—')
})

test('signClass: zero and non-finite are neutral', () => {
  expect(signClass(1)).toBe('text-green')
  expect(signClass(-1)).toBe('text-red-text')
  for (const v of [0, null, undefined, NaN]) expect(signClass(v)).toBe('text-text-secondary')
})
