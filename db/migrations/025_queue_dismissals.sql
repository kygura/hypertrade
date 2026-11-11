-- Queue dismissals (docs/SPEC.md § Queue; src/server/queue/merge.ts): one row per coin per UTC day; a re-dismiss
-- after the coin re-entered (a newer part arrived) moves dismissed_at. A dismissed coin keeps its slot in the day's
-- budget. Apply after 024; safe to re-run.
create table if not exists queue_dismissals (
  day          text        not null check (day ~ '^\d{4}-\d{2}-\d{2}$'),
  coin         text        not null,
  dismissed_at timestamptz not null,
  primary key (day, coin)
);
-- 022_enable_rls.sql: every public table has RLS on (no policies: the app's role bypasses it).
alter table queue_dismissals enable row level security;
