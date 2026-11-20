-- Stop map (src/server/platform/stopmapLoop.ts; docs/SPEC.md § stopmap): every 15 min, the resting reduce-only stop
-- orders (HL frontendOpenOrders) of the crawled wallets holding a top coin, bucketed on the liqmap grid. Shaped like
-- liqmap_snapshots; `wallets` is how many polled wallets hold the coin (empty buckets with wallets > 0 = no stops seen).
-- Pruned at PLATFORM_RETENTION_DAYS with the liqmap. Apply after 029; safe to re-run.

create table if not exists stopmap_snapshots (
  coin       text not null,
  ts         timestamptz not null,
  mark       double precision not null check (mark > 0),
  bucket_bps double precision not null check (bucket_bps > 0),
  buckets    jsonb not null,
  wallets    integer not null check (wallets >= 0),
  primary key (coin, ts)
);
create index if not exists stopmap_snapshots_ts_idx on stopmap_snapshots (ts);

-- 022_enable_rls.sql: every public table has RLS on (no policies: the app's role bypasses it).
alter table stopmap_snapshots enable row level security;
