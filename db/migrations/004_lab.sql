-- Lab: rule-discovery runs and the saved-rule catalogue (LAB.md "Persistence").
-- Apply after 003.

-- One search: the config it ran with, and the full SearchResult (or the error).
create table if not exists lab_runs (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  source      text not null check (source in ('api', 'mcp', 'cli', 'ui')),
  config      jsonb not null,
  status      text not null check (status in ('ok', 'error')),
  error       text,
  result      jsonb,
  duration_ms integer
);
create index if not exists lab_runs_created_idx on lab_runs (created_at desc);

-- The catalogue: a rule (id = stable hash of the rule) with its evaluation at
-- save time. saved_at starts the live window, so re-saving never moves it.
-- Archiving hides a rule without losing it.
create table if not exists lab_rules (
  id          text primary key,
  name        text not null,
  note        text,
  origin      text not null check (origin in ('user', 'agent', 'seed')),
  run_id      uuid references lab_runs on delete set null,
  asset       text not null,
  direction   text not null,
  rule        jsonb not null,
  saved       jsonb not null,
  saved_at    timestamptz not null default now(),
  archived_at timestamptz
);
create index if not exists lab_rules_active_idx on lab_rules (asset, direction) where archived_at is null;
