import postgres from 'postgres'

// DB row shapes. Distinct from src/shared/types.ts on purpose: shared types
// model computed/HL payloads (epoch-ms timestamps), these model Postgres rows.
export type SeriesDef = { id: string; source?: string; units?: string; description?: string }
export type Observation = { seriesId: string; ts: Date | string; value: number }
export type Point = { ts: Date; value: number }
export type MetricSummary = {
  seriesId: string
  ts: Date | null
  latest: number | null
  previous: number | null
  delta: number | null
  mean30: number | null
  stddev30: number | null
  mean90: number | null
  stddev90: number | null
  z30: number | null
}
export type Candle = { coin: string; tf: string; ts: Date | string; o: number; h: number; l: number; c: number; v?: number | null; src?: string }
export type Branch = { id: string; name: string; config: unknown; createdAt: Date; updatedAt: Date }
export type BranchResult = { branchId: string; computedAt: Date; result: unknown }

let client: postgres.Sql | null = null

/**
 * The connection string. DATABASE_URL wins; otherwise the pooled URL the
 * Vercel Supabase integration injects, under its default `DATABASE_` prefix
 * or with no prefix.
 */
export function databaseUrl(env: Record<string, string | undefined> = process.env): string | undefined {
  const raw = env.DATABASE_URL || env.DATABASE_POSTGRES_URL || env.POSTGRES_URL
  if (!raw) return undefined
  // postgres.js forwards unknown query parameters to the server as settings,
  // and the integration's URL carries ones Postgres rejects (`supa=...`,
  // `pgbouncer=true`). Only sslmode is meant for the client.
  try {
    const url = new URL(raw)
    for (const key of [...url.searchParams.keys()]) {
      if (key !== 'sslmode') url.searchParams.delete(key)
    }
    return url.toString()
  } catch {
    return raw
  }
}

/** Lazy singleton. Nothing connects at import time; builds and tests run without a DB. */
export function sql(): postgres.Sql {
  if (client) return client
  const url = databaseUrl()
  if (!url) throw new Error('DATABASE_URL is not set — database queries are unavailable')
  // prepare:false is required behind Supabase's transaction pooler.
  // fetch_types:false skips postgres.js's pg_type scan on connect: on Supabase
  // it can hit the statement timeout, blocking the one connection meanwhile and
  // then crashing the process with an unhandled rejection. No query here relies
  // on array types (lists go through `in ${sql()(ids)}`).
  client = postgres(url, { max: 1, prepare: false, idle_timeout: 20, fetch_types: false })
  return client
}

/**
 * Drops the shared client so the next query opens a fresh connection; queries
 * already in flight get 5s to finish. A connection left idle across a Fluid
 * suspend can come back unusable (the next query hangs with no error), which
 * is what Vercel's attachDatabasePool guards against for pg pools.
 */
export async function releaseConnection(): Promise<void> {
  const c = client
  client = null
  await c?.end({ timeout: 5 })
}

// ---------------------------------------------------------------- series

export async function ensureSeries(defs: SeriesDef[]): Promise<void> {
  if (defs.length === 0) return
  const rows = defs.map((d) => ({
    id: d.id,
    source: d.source ?? null,
    units: d.units ?? null,
    description: d.description ?? null,
  }))
  await sql()`
    insert into series ${sql()(rows, 'id', 'source', 'units', 'description')}
    on conflict (id) do update set
      source = excluded.source, units = excluded.units, description = excluded.description
  `
}

export async function upsertObservations(rows: Observation[]): Promise<number> {
  if (rows.length === 0) return 0
  const values = rows.map((r) => ({ series_id: r.seriesId, ts: r.ts, value: r.value }))
  const res = await sql()`
    insert into observations ${sql()(values, 'series_id', 'ts', 'value')}
    on conflict (series_id, ts) do update set value = excluded.value
  `
  return res.count
}

export async function latestObservations(seriesIds: string[]): Promise<(Point & { seriesId: string })[]> {
  if (seriesIds.length === 0) return []
  const rows = await sql()<{ series_id: string; ts: Date; value: number }[]>`
    select distinct on (series_id) series_id, ts, value
    from observations
    where series_id in ${sql()(seriesIds)}
    order by series_id, ts desc
  `
  return rows.map((r) => ({ seriesId: r.series_id, ts: r.ts, value: r.value }))
}

/**
 * Observations for one series. With `buckets`, downsamples to at most that many
 * equal-width time buckets (plain Postgres width_bucket, no timescale).
 */
export async function seriesRange(
  seriesId: string,
  from?: Date | string,
  to?: Date | string,
  buckets?: number,
): Promise<Point[]> {
  const db = sql()
  const lo = from ?? null
  const hi = to ?? null
  if (!buckets || buckets <= 0) {
    return db<Point[]>`
      select ts, value from observations
      where series_id = ${seriesId}
        and (${lo}::timestamptz is null or ts >= ${lo})
        and (${hi}::timestamptz is null or ts <= ${hi})
      order by ts
    `
  }
  return db<Point[]>`
    with pts as (
      select ts, value from observations
      where series_id = ${seriesId}
        and (${lo}::timestamptz is null or ts >= ${lo})
        and (${hi}::timestamptz is null or ts <= ${hi})
    ),
    bounds as (
      select extract(epoch from min(ts)) as lo, extract(epoch from max(ts)) as hi from pts
    )
    select min(pts.ts) as ts, avg(pts.value) as value
    from pts, bounds
    group by width_bucket(extract(epoch from pts.ts), bounds.lo, bounds.hi + 1, ${buckets})
    order by 1
  `
}

type SummaryRow = {
  series_id: string
  ts: Date | null
  latest: number | null
  previous: number | null
  mean30: number | null
  stddev30: number | null
  n30: number
  mean90: number | null
  stddev90: number | null
}

const Z_MIN_N = 5

/** Pure mapping: derives delta and z30 from the aggregate row. Exported for tests. */
export function toMetricSummary(r: SummaryRow): MetricSummary {
  const delta = r.latest !== null && r.previous !== null ? r.latest - r.previous : null
  const z30 =
    r.latest !== null && r.mean30 !== null && r.stddev30 !== null && r.stddev30 !== 0 && r.n30 >= Z_MIN_N
      ? (r.latest - r.mean30) / r.stddev30
      : null
  return {
    seriesId: r.series_id,
    ts: r.ts,
    latest: r.latest,
    previous: r.previous,
    delta,
    mean30: r.mean30,
    stddev30: r.stddev30,
    mean90: r.mean90,
    stddev90: r.stddev90,
    z30,
  }
}

/** Latest value + previous (delta) + mean/stddev over the last 30 and 90 observations. */
export async function summaryFor(seriesIds: string[]): Promise<MetricSummary[]> {
  if (seriesIds.length === 0) return []
  const rows = await sql()<SummaryRow[]>`
    with ranked as (
      select series_id, ts, value,
             row_number() over (partition by series_id order by ts desc) as rn
      from observations
      where series_id in ${sql()(seriesIds)}
    )
    select series_id,
           max(ts)    filter (where rn = 1)   as ts,
           max(value) filter (where rn = 1)   as latest,
           max(value) filter (where rn = 2)   as previous,
           avg(value)        filter (where rn <= 30) as mean30,
           stddev_pop(value) filter (where rn <= 30) as stddev30,
           count(*)::int     filter (where rn <= 30) as n30,
           avg(value)        filter (where rn <= 90) as mean90,
           stddev_pop(value) filter (where rn <= 90) as stddev90
    from ranked
    where rn <= 90
    group by series_id
  `
  return rows.map(toMetricSummary)
}

// ---------------------------------------------------------- collector runs

export async function recordCollectorRun(
  collector: string,
  startedAt: Date,
  ok: boolean,
  error?: string | null,
): Promise<void> {
  await sql()`
    insert into collector_runs (collector, started_at, finished_at, ok, error)
    values (${collector}, ${startedAt}, now(), ${ok}, ${error ?? null})
  `
}

// --------------------------------------------------------------- candles

const UPSERT_CHUNK = 2000

export async function upsertCandles(rows: Candle[]): Promise<number> {
  let count = 0
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    const values = rows.slice(i, i + UPSERT_CHUNK).map((r) => ({
      coin: r.coin, tf: r.tf, ts: r.ts, o: r.o, h: r.h, l: r.l, c: r.c, v: r.v ?? null, src: r.src ?? 'hl',
    }))
    const res = await sql()`
      insert into candles ${sql()(values, 'coin', 'tf', 'ts', 'o', 'h', 'l', 'c', 'v', 'src')}
      on conflict (coin, tf, ts) do update set
        o = excluded.o, h = excluded.h, l = excluded.l, c = excluded.c, v = excluded.v, src = excluded.src
    `
    count += res.count
  }
  return count
}

export async function getCandles(coin: string, tf: string, from?: Date | string): Promise<Candle[]> {
  const lo = from ?? null
  return sql()<Candle[]>`
    select coin, tf, ts, o, h, l, c, v, src from candles
    where coin = ${coin} and tf = ${tf}
      and (${lo}::timestamptz is null or ts >= ${lo})
    order by ts
  `
}

/** Candles with from <= ts < to, ascending. */
export async function getCandlesBetween(coin: string, tf: string, from: Date, to: Date): Promise<Candle[]> {
  return sql()<Candle[]>`
    select coin, tf, ts, o, h, l, c, v, src from candles
    where coin = ${coin} and tf = ${tf} and ts >= ${from} and ts < ${to}
    order by ts
  `
}

/** The `limit` most recent candles with ts < before, returned ascending. */
export async function getCandlesBefore(coin: string, tf: string, before: Date, limit: number): Promise<Candle[]> {
  const rows = await sql()<Candle[]>`
    select coin, tf, ts, o, h, l, c, v, src from candles
    where coin = ${coin} and tf = ${tf} and ts < ${before}
    order by ts desc
    limit ${limit}
  `
  return rows.reverse()
}

export async function candleCoverage(coin: string, tf: string): Promise<{ min: Date; max: Date } | null> {
  const [row] = await sql()<{ min: Date | null; max: Date | null }[]>`
    select min(ts) as min, max(ts) as max from candles where coin = ${coin} and tf = ${tf}
  `
  return row?.min && row.max ? { min: row.min, max: row.max } : null
}

/**
 * Drops bars older than `before` for one timeframe (retention for the finest
 * intervals). No index leads with tf, so this scans; the local statement
 * timeout keeps a slow scan from eating the cron's time budget.
 */
export async function pruneCandles(tf: string, before: Date, timeoutMs = 15_000): Promise<number> {
  return sql().begin(async (tx) => {
    await tx.unsafe(`set local statement_timeout = ${Math.floor(timeoutMs)}`)
    const res = await tx`delete from candles where tf = ${tf} and ts < ${before}`
    return res.count
  }) as Promise<number>
}

// ------------------------------------------------------------ sync state

export type ExtLayerState = { status: 'ok' | 'none'; floor: number | null; exhausted: boolean }
export type SyncState = {
  coin: string
  series: string
  hlFloor: number | null
  ext: Partial<Record<string, ExtLayerState>>
  syncedAt: number | null
  accessedAt: number | null
  error: string | null
}

const ms = (d: Date | null) => (d ? d.getTime() : null)
const dt = (n: number | null) => (n == null ? null : new Date(n))

export async function getSyncState(coin: string, series: string): Promise<SyncState> {
  const [row] = await sql()<{ hl_floor: Date | null; ext: SyncState['ext'] | null; synced_at: Date | null; accessed_at: Date | null; error: string | null }[]>`
    select hl_floor, ext, synced_at, accessed_at, error from sync_state where coin = ${coin} and series = ${series}
  `
  return {
    coin,
    series,
    hlFloor: ms(row?.hl_floor ?? null),
    ext: row?.ext ?? {},
    syncedAt: ms(row?.synced_at ?? null),
    accessedAt: ms(row?.accessed_at ?? null),
    error: row?.error ?? null,
  }
}

export async function saveSyncState(s: SyncState): Promise<void> {
  await sql()`
    insert into sync_state (coin, series, hl_floor, ext, synced_at, accessed_at, error)
    values (${s.coin}, ${s.series}, ${dt(s.hlFloor)}, ${sql().json(s.ext as never)}, ${dt(s.syncedAt)}, ${dt(s.accessedAt)}, ${s.error})
    on conflict (coin, series) do update set
      hl_floor = excluded.hl_floor, ext = excluded.ext, synced_at = excluded.synced_at,
      accessed_at = coalesce(excluded.accessed_at, sync_state.accessed_at), error = excluded.error
  `
}

export async function touchSyncAccess(coin: string, series: string): Promise<void> {
  await sql()`
    insert into sync_state (coin, series, accessed_at) values (${coin}, ${series}, now())
    on conflict (coin, series) do update set accessed_at = now()
  `
}

/** Coins any chart asked for since `since`. */
export async function recentlyAccessedCoins(since: Date): Promise<string[]> {
  const rows = await sql()<{ coin: string }[]>`
    select distinct coin from sync_state where accessed_at >= ${since} order by coin
  `
  return rows.map((r) => r.coin)
}

// --------------------------------------------------------------- funding

export type FundingRow = { ts: Date; rate: number; premium: number }

export async function upsertFunding(coin: string, rows: { t: number; rate: number; premium: number }[]): Promise<number> {
  let count = 0
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    const values = rows.slice(i, i + UPSERT_CHUNK).map((r) => ({ coin, ts: new Date(r.t), rate: r.rate, premium: r.premium }))
    const res = await sql()`
      insert into funding ${sql()(values, 'coin', 'ts', 'rate', 'premium')}
      on conflict (coin, ts) do update set rate = excluded.rate, premium = excluded.premium
    `
    count += res.count
  }
  return count
}

/** Funding rows with from <= ts <= to, ascending. */
export async function getFunding(coin: string, from: Date, to: Date): Promise<FundingRow[]> {
  return sql()<FundingRow[]>`
    select ts, rate, premium from funding where coin = ${coin} and ts >= ${from} and ts <= ${to} order by ts
  `
}

export async function fundingCoverage(coin: string): Promise<{ min: Date; max: Date } | null> {
  const [row] = await sql()<{ min: Date | null; max: Date | null }[]>`
    select min(ts) as min, max(ts) as max from funding where coin = ${coin}
  `
  return row?.min && row.max ? { min: row.min, max: row.max } : null
}

// -------------------------------------------------------------- branches

export type BranchListRow = Branch & { result: unknown }

export async function listBranches(): Promise<BranchListRow[]> {
  const rows = await sql()<any[]>`
    select b.id, b.name, b.config, b.created_at, b.updated_at, r.result
    from branches b
    left join branch_results r on r.branch_id = b.id
    order by b.updated_at desc
  `
  return rows.map((r) => ({ ...toBranch(r), result: r.result ?? null }))
}

export async function getBranch(id: string): Promise<Branch | null> {
  const [row] = await sql()<any[]>`
    select id, name, config, created_at, updated_at from branches where id = ${id}
  `
  return row ? toBranch(row) : null
}

export async function createBranch(name: string, config: unknown): Promise<Branch> {
  const [row] = await sql()<any[]>`
    insert into branches (name, config) values (${name}, ${sql().json(config as never)})
    returning id, name, config, created_at, updated_at
  `
  return toBranch(row)
}

export async function updateBranch(
  id: string,
  patch: { name?: string; config?: unknown },
): Promise<Branch | null> {
  const [row] = await sql()<any[]>`
    update branches set
      name = coalesce(${patch.name ?? null}, name),
      config = coalesce(${patch.config === undefined ? null : sql().json(patch.config as never)}::jsonb, config),
      updated_at = now()
    where id = ${id}
    returning id, name, config, created_at, updated_at
  `
  return row ? toBranch(row) : null
}

export async function deleteBranch(id: string): Promise<boolean> {
  const res = await sql()`delete from branches where id = ${id}`
  return res.count > 0
}

export async function saveBranchResult(branchId: string, result: unknown): Promise<void> {
  await sql()`
    insert into branch_results (branch_id, computed_at, result)
    values (${branchId}, now(), ${sql().json(result as never)})
    on conflict (branch_id) do update set computed_at = now(), result = excluded.result
  `
}

export async function getBranchResult(branchId: string): Promise<BranchResult | null> {
  const [row] = await sql()<{ branch_id: string; computed_at: Date; result: unknown }[]>`
    select branch_id, computed_at, result from branch_results where branch_id = ${branchId}
  `
  return row ? { branchId: row.branch_id, computedAt: row.computed_at, result: row.result } : null
}

function toBranch(r: any): Branch {
  return { id: r.id, name: r.name, config: r.config, createdAt: r.created_at, updatedAt: r.updated_at }
}
