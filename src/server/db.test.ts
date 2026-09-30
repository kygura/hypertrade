import { describe, expect, test } from 'bun:test'
import { databaseUrl, toMetricSummary } from './db.js'

const base = {
  series_id: 'hl.total_oi_usd',
  ts: new Date('2026-01-01T00:00:00Z'),
  latest: 110,
  previous: 100,
  mean30: 100,
  stddev30: 5,
  n30: 30,
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

test('z30 stays null below n=5 even when stddev30 is nonzero (n>=5 contract)', () => {
  expect(toMetricSummary({ ...base, n30: 4 }).z30).toBeNull()
  expect(toMetricSummary({ ...base, n30: 5 }).z30).toBe(2)
})

describe('databaseUrl', () => {
  test('prefers DATABASE_URL, then the Supabase integration variables', () => {
    expect(databaseUrl({ DATABASE_URL: 'postgres://a@h/db', DATABASE_POSTGRES_URL: 'postgres://b@h/db' })).toBe(
      'postgres://a@h/db',
    )
    expect(databaseUrl({ DATABASE_POSTGRES_URL: 'postgres://b@h/db' })).toBe('postgres://b@h/db')
    expect(databaseUrl({ POSTGRES_URL: 'postgres://c@h/db' })).toBe('postgres://c@h/db')
    expect(databaseUrl({})).toBeUndefined()
  })

  test('keeps sslmode and drops parameters Postgres would reject', () => {
    const url = databaseUrl({
      DATABASE_POSTGRES_URL: 'postgres://u:p@aws-0.pooler.supabase.com:6543/postgres?sslmode=require&supa=base-pooler.x&pgbouncer=true',
    })
    expect(url).toBe('postgres://u:p@aws-0.pooler.supabase.com:6543/postgres?sslmode=require')
  })
})
