-- Research study cache (src/server/research/study.ts, docs/RESEARCH.md B2): one row per event study run on
-- request, keyed by its study id (rule hash : coin or * : stopAtr : targetAtr : UTC day), so a restart keeps
-- today's evidence and an identical study is not logged as a second trial. `summary` is the StudySummary, `study`
-- the full lab_event_study result. Rows older than a few days are pruned on insert (src/server/lab/store.ts).
create table if not exists research_studies (
  key        text        primary key,
  summary    jsonb       not null,
  study      jsonb       not null,
  created_at timestamptz not null default now()
);
create index if not exists research_studies_created_idx on research_studies (created_at);
-- 022_enable_rls.sql: every public table has RLS on (no policies: the app's role bypasses it).
alter table research_studies enable row level security;
