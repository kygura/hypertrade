-- Extreme events (src/shared/extremes.ts; src/server/extremes/job.ts): one row per detector hit the 15-min extremes
-- job kept (past the per-key cooldown), with how it left the process (`delivery`: a research session was woken, the
-- facts were pushed, or nothing went out because of the daily cap) and, later, the research session's verdict.
-- `event` and `verdict` are the zod-parsed contracts (jsonb: db.ts runs with fetch_types off). The cooldown reads the
-- latest row per key; the daily cap counts delivered rows by bar time. A verdict is written once. Apply after 026;
-- safe to re-run.

create table if not exists extreme_events (
  key        text        not null,
  ts         timestamptz not null,
  coin       text        not null,
  delivery   text        not null check (delivery in ('woken', 'pushed', 'none')),
  event      jsonb       not null,
  verdict    jsonb,
  verdict_at timestamptz,
  primary key (key, ts)
);
create index if not exists extreme_events_ts on extreme_events (ts desc);

-- 022_enable_rls.sql: every public table has RLS on (no policies: the app's role bypasses it).
alter table extreme_events enable row level security;
