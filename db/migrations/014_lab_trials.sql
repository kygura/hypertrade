-- Global trial log (FEATURES.md section 5): append-only, never reset. One row
-- per authored rule idea; n is the idea number, the table size is N.
create table if not exists lab_trials (
  n       bigserial primary key,
  at      timestamptz not null default now(),
  rule_id text not null,
  intent  text,
  verdict text
);
create index if not exists lab_trials_rule_idx on lab_trials (rule_id, n);
