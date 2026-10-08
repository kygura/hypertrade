-- Desk: the agentic portfolio desk (SPEC.md "Desk"). Runs of the agent team,
-- their event logs, governed trade proposals, the paper book, alerts, and a
-- small key/value table for switches and cursors. Apply after 002.

-- One orchestrator run: an operator question ('ask') or an autonomous review
-- ('cycle', fired by the watch tick or a schedule).
create table if not exists desk_runs (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null check (kind in ('ask', 'cycle')),
  question    text not null,
  trigger     jsonb,
  status      text not null default 'running' check (status in ('running', 'done', 'error')),
  answer      text,
  usage       jsonb,
  cost_usd    double precision,
  error       text,
  started_at  timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists desk_runs_started_idx on desk_runs (started_at desc);

-- Every event the run emitted (agent start/finish, tool calls, text, proposals),
-- in order. Replayed by the UI for a finished run.
create table if not exists desk_events (
  run_id uuid not null references desk_runs on delete cascade,
  seq    integer not null,
  ts     timestamptz not null default now(),
  agent  text not null,
  type   text not null,
  data   jsonb not null,
  primary key (run_id, seq)
);

-- A trade the agents proposed, the governor's verdict on it, and what became of it.
create table if not exists desk_proposals (
  id          uuid primary key default gen_random_uuid(),
  run_id      uuid references desk_runs on delete set null,
  kind        text not null check (kind in ('open', 'exit')),
  status      text not null check (status in ('pending', 'rejected', 'blocked', 'executed', 'failed', 'expired')),
  venue       text not null,
  proposal    jsonb not null,
  verdict     jsonb not null,
  execution   jsonb,
  decided_by  text,
  decided_at  timestamptz,
  expires_at  timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists desk_proposals_created_idx on desk_proposals (created_at desc);
create index if not exists desk_proposals_pending_idx on desk_proposals (status) where status = 'pending';

-- Paper book: one net position per coin with its protective orders.
create table if not exists desk_paper_positions (
  coin        text primary key,
  side        text not null check (side in ('long', 'short')),
  size        double precision not null,
  entry_px    double precision not null,
  stop_px     double precision not null,
  tp_px       double precision,
  proposal_id uuid,
  opened_at   timestamptz not null default now()
);

create table if not exists desk_paper_fills (
  id          bigserial primary key,
  ts          timestamptz not null default now(),
  coin        text not null,
  side        text not null,
  size        double precision not null,
  px          double precision not null,
  fee         double precision not null,
  pnl         double precision not null default 0,
  reason      text not null,
  proposal_id uuid
);
create index if not exists desk_paper_fills_ts_idx on desk_paper_fills (ts desc);

create table if not exists desk_alerts (
  id       bigserial primary key,
  ts       timestamptz not null default now(),
  level    text not null check (level in ('info', 'warn', 'critical')),
  title    text not null,
  body     text not null,
  run_id   uuid,
  channels jsonb not null default '[]'::jsonb
);
create index if not exists desk_alerts_ts_idx on desk_alerts (ts desc);

-- Switches and cursors: kill switch, mode override, paper balance, trigger
-- cooldowns, Telegram update offset.
create table if not exists desk_state (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);
