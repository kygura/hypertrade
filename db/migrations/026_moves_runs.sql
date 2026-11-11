-- Moves runs as data (docs/SPEC.md § Moves M3, M4; src/server/moves/jobs.ts): the serverless API has no in-process
-- moves service, so the hourly moves job stores its answer and the read routes serve it.
-- moves_runs: the latest run per window, replaced each run (`win`: `window` is a reserved word). Only the latest is
-- ever read (GET /api/moves, the triage pass); agent records keep their own inputs, so no history is kept and nothing
-- needs pruning. `body` is the zod-parsed MovesResponse (jsonb: db.ts runs with fetch_types off). An older run never
-- replaces a newer one (computed_at), so the always-on server and the cron can both write.
-- moves_triage_scan: the latest triage pass (one row): what /api/moves/triage and /api/queue read as `watched`,
-- `overBudget` and the pass's state. Apply after 025; safe to re-run.

create table if not exists moves_runs (
  win         text        primary key check (win in ('4h', '24h', '72h')),
  as_of       timestamptz not null,
  computed_at timestamptz not null,
  body        jsonb       not null
);

create table if not exists moves_triage_scan (
  id   text        primary key check (id = 'latest'),
  at   timestamptz not null,
  body jsonb       not null
);

-- 022_enable_rls.sql: every public table has RLS on (no policies: the app's role bypasses it).
alter table moves_runs enable row level security;
alter table moves_triage_scan enable row level security;
