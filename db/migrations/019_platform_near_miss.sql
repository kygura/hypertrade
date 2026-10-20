-- Near-misses of the latest completed scan: one row, replaced each scan. The scanner holds them
-- in memory; this row lets a process without the scanner (the DB-only API on Vercel) serve them.
create table if not exists platform_near_miss (
  id    text primary key check (id = 'latest'),
  ts    timestamptz not null,
  items jsonb       not null
);
