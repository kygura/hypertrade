import { expect, test } from 'bun:test'
import { toMetricSummary } from './db'

const base = {
  series_id: 'hl.total_oi_usd',
  ts: new Date('2026-01-01T00:00:00Z'),
  latest: 110,
  previous: 100,
  mean30: 100,
  stddev30: 5,
  mean90: 90,
  stddev90: 10,
}

test('derives delta and z30', () => {
  const s = toMetricSummary(base)
  expect(s.delta).toBe(10)
  expect(s.z30).toBe(2)
})

test('null-safe when history is thin or flat', () => {
  expect(toMetricSummary({ ...base, previous: null }).delta).toBeNull()
  expect(toMetricSummary({ ...base, stddev30: 0 }).z30).toBeNull()
  expect(toMetricSummary({ ...base, latest: null, mean30: null, stddev30: null }).z30).toBeNull()
})
