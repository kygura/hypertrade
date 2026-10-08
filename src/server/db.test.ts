import { afterAll, afterEach, beforeAll, describe, expect, setSystemTime, test } from 'bun:test'
import * as db from './db.js'
import { databaseUrl, QueryTimeoutError, releaseConnection, sql, toMetricSummary } from './db.js'
import { startFakePg, type FakePg } from './testing/fakePg.js'

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

describe('query timeout', () => {
  const TIMEOUT_MS = 150
  const saved = { url: process.env.DATABASE_URL, timeout: process.env.DB_QUERY_TIMEOUT_MS }
  let fake: FakePg

  beforeAll(async () => {
    fake = await startFakePg()
    await releaseConnection()
    process.env.DATABASE_URL = fake.url
    process.env.DB_QUERY_TIMEOUT_MS = String(TIMEOUT_MS)
  })
  afterEach(async () => {
    setSystemTime()
    fake.mode = 'answer'
    await releaseConnection()
  })
  afterAll(async () => {
    await fake.close()
    for (const [k, v] of [['DATABASE_URL', saved.url], ['DB_QUERY_TIMEOUT_MS', saved.timeout]] as const) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  const outcome = (p: Promise<unknown>) =>
    p.then(
      () => 'ok',
      (e) => (e instanceof QueryTimeoutError ? 'timeout' : `error ${(e as { code?: string }).code ?? e}`),
    )

  test('answered queries, fragments and helpers run as before', async () => {
    expect(await sql()`select 1`).toHaveLength(0)
    const q = sql()
    expect(await q`select * from lab_rules where true ${q`and asset = ${'BTC'}`} ${q``}`).toHaveLength(0)
    expect(await db.upsertObservations([{ seriesId: 'lab.x', ts: new Date(0), value: 1 }])).toBe(0)
    expect(fake.connections).toBe(1)
  })

  test('a query that never gets an answer fails, frees the queries queued behind it, and the next one reconnects', async () => {
    await sql()`select 1`
    const connections = fake.connections
    fake.mode = 'silent'
    const started = Date.now()
    // The Lab collector's write wedges the one connection; another route's read queues behind it.
    const wedged = outcome(db.upsertObservations([{ seriesId: 'lab.x', ts: new Date(0), value: 1 }]))
    const queued = outcome(db.listBranches())
    expect(await wedged).toBe('timeout')
    expect(await queued).toBe('timeout')
    expect(Date.now() - started).toBeLessThan(TIMEOUT_MS * 5)

    fake.mode = 'answer'
    expect(await outcome(db.listBranches())).toBe('ok')
    expect(fake.connections).toBe(connections + 1)
  })

  test('a transaction that stalls times out the same way', async () => {
    await sql()`select 1`
    fake.mode = 'silent'
    expect(await outcome(db.pruneCandles('1m', new Date(0)))).toBe('timeout')
    fake.mode = 'answer'
    expect(await outcome(sql()`select 1`)).toBe('ok')
  })

  test('the timeout message names the query', async () => {
    fake.mode = 'silent'
    const err = await db.listBranches().catch((e) => e)
    expect(err).toBeInstanceOf(QueryTimeoutError)
    expect(err.message).toStartWith(`query timed out after ${TIMEOUT_MS / 1000}s: select b.id, b.name, b.config`)
  })

  test('a connection idle past idle_timeout (a suspended process) is replaced before the next query', async () => {
    const t0 = Date.now()
    await sql()`select 1`
    const connections = fake.connections
    setSystemTime(new Date(t0 + 10_000))
    await sql()`select 1`
    expect(fake.connections).toBe(connections)
    setSystemTime(new Date(t0 + 31_000))
    await sql()`select 1`
    expect(fake.connections).toBe(connections + 1)
  })
})
