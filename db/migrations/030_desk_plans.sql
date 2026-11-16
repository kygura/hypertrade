-- Desk plan journal (src/server/desk/plan.ts, DeskService.submitPlan; shared/deskPlan.ts DeskPlanRecord): every
-- written plan, placed or not, and every order confirmed through the /order copilot as a one-rung plan. `input`,
-- `metrics`, `blockers`, `warnings` and `placement` are jsonb (db.ts runs with fetch_types off: no array params).
-- `seq` orders entries written in the same instant. Apply after 029; safe to re-run.

create table if not exists desk_plans (
  id         uuid        primary key default gen_random_uuid(),
  seq        bigserial   not null,
  created_at timestamptz not null default now(),
  source     text        not null check (source in ('plan', 'copilot')),
  venue      text        not null,
  coin       text        not null,
  input      jsonb       not null,
  metrics    jsonb       not null,
  blockers   jsonb       not null default '[]'::jsonb,
  warnings   jsonb       not null default '[]'::jsonb,
  placed     boolean     not null default false,
  placement  jsonb
);
create index if not exists desk_plans_created_idx on desk_plans (created_at desc, seq desc);

-- 022_enable_rls.sql: every public table has RLS on (no policies: the app's role bypasses it).
alter table desk_plans enable row level security;
