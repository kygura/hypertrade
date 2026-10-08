-- Lab: guard against a different Lab schema. Apply after 004; safe to re-run.
--
-- Another branch's 004 created lab_rules (report jsonb) and lab_runs
-- (request jsonb) under the same names. If it was applied first, 004's
-- "create table if not exists" silently kept those tables and every Lab
-- write fails later; stop here instead, with what to do.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = current_schema()
      and ((table_name = 'lab_rules' and column_name = 'report') or (table_name = 'lab_runs' and column_name = 'request'))
  ) then
    raise exception 'lab_rules/lab_runs come from another Lab schema (lab_rules.report or lab_runs.request exists). Rename or drop both tables, then re-apply 004_lab.sql and this file.';
  end if;
end $$;

-- That schema's index duplicates lab_runs_created_idx.
drop index if exists lab_runs_created_at;
