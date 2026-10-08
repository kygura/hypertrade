-- Lab: saved research rules (the catalogue) and recent search runs.
-- Apply after 003_desk.sql. Lab history itself lives in the existing
-- series/observations tables (bc.*, cm.btc.*, fng.value, ...), and per-source
-- sync bookkeeping in sync_state under coin = '_lab'.

create table if not exists lab_rules (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  -- Who saved it: ui | cli | mcp. Everything after created_at is unseen data
  -- for this rule, which is what the catalogue's live check reports.
  source     text not null default 'ui',
  note       text,
  -- LabRuleReport (src/shared/lab.ts) as it stood when saved.
  report     jsonb not null
);

create table if not exists lab_runs (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  request    jsonb not null,
  -- LabSearchResult; the newest 30 runs are kept.
  result     jsonb not null
);

create index if not exists lab_runs_created_at on lab_runs (created_at desc);
