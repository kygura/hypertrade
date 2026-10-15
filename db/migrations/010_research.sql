-- Scout research (SPEC.md § Scout S0.4): one row per research run. `body`
-- holds the rest of the ResearchResult (explanation, evidence, ...). A
-- 'running' row is the cross-instance lock (S0.3): the partial unique index
-- allows at most one, and a stale one is marked failed before a new run
-- starts. 90-day retention (pruned by /cron/backfill).
-- Apply after 009; safe to re-run.
create table if not exists intel_research (
  id         uuid primary key default gen_random_uuid(),
  trigger    text not null check (trigger in ('manual', 'flag')),
  flag_id    text,
  asset      text,
  status     text not null check (status in ('running', 'found', 'no_cause', 'capped', 'failed')),
  body       jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists intel_research_created_idx on intel_research (created_at desc);
create index if not exists intel_research_flag_idx on intel_research (flag_id) where flag_id is not null;
create unique index if not exists intel_research_one_running on intel_research ((true)) where status = 'running';
