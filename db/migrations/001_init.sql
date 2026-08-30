-- HYPERTRADE initial schema. Apply to Supabase Postgres.
-- "Everything is a series" (ported from marketwatch) + candle cache + branches.

create extension if not exists pgcrypto;

create table if not exists series (
  id          text primary key,
  source      text,
  units       text,
  description text
);

create table if not exists observations (
  series_id text not null references series (id) on delete cascade,
  ts        timestamptz not null,
  value     double precision not null,
  primary key (series_id, ts)
);

create table if not exists collector_runs (
  id          bigserial primary key,
  collector   text not null,
  started_at  timestamptz not null,
  finished_at timestamptz,
  ok          boolean not null,
  error       text
);

-- Backfill cache for the simulator and charts.
create table if not exists candles (
  coin text not null,
  tf   text not null,
  ts   timestamptz not null,
  o    double precision not null,
  h    double precision not null,
  l    double precision not null,
  c    double precision not null,
  v    double precision,
  primary key (coin, tf, ts)
);

create table if not exists branches (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  config     jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Latest simulation output cache; one row per branch.
create table if not exists branch_results (
  branch_id   uuid primary key references branches (id) on delete cascade,
  computed_at timestamptz not null default now(),
  result      jsonb not null
);

-- No secondary indexes: every read path in src/server/db.ts is served by a
-- primary key prefix (series_id/ts, coin/tf/ts, branch_id).
