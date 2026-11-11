-- Agent watch (docs/SPEC.md § Moves; src/shared/agentRecords.ts, src/server/moves/agent*.ts): the records an
-- investigation agent writes, graded later by code, and the daily triage queue. The full zod-parsed record or item
-- sits in `body` (lists and nested objects as jsonb: db.ts runs with fetch_types off); the scalar columns exist to
-- filter, order and count. A restart keeps the day's triage budget and agent count. Apply after 023; safe to re-run.

create table if not exists agent_records (
  id         text        primary key,
  coin       text        not null,
  status     text        not null check (status in ('open', 'falsified', 'graded', 'no_cause', 'failed', 'capped')),
  created_at timestamptz not null,
  -- Set when the call reached a provider: agentRunsSince counts these rows (capped and no-provider rows are not runs).
  model      text,
  body       jsonb       not null
);
create index if not exists agent_records_created_idx on agent_records (created_at desc);
create index if not exists agent_records_coin_idx on agent_records (coin, created_at desc);
create index if not exists agent_records_status_idx on agent_records (status);

-- One item per coin per UTC day; dismissed items stay (they count against the day's budget).
create table if not exists triage_items (
  id          text        primary key,
  day         text        not null check (day ~ '^\d{4}-\d{2}-\d{2}$'),
  coin        text        not null,
  score       double precision not null,
  body        jsonb       not null,
  unique (day, coin)
);
create index if not exists triage_items_day_idx on triage_items (day);

-- 022_enable_rls.sql: every public table has RLS on (no policies: the app's role bypasses it).
alter table agent_records enable row level security;
alter table triage_items enable row level security;
