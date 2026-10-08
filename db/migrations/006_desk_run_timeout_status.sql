-- Desk: a run that hit its wall-clock deadline (agents.ts PM_RESERVE_MS /
-- DEFAULT_RUN_TIMEOUT_MS) is now stored as 'timeout', not 'done'. Apply
-- after 005; safe to re-run.
alter table desk_runs drop constraint if exists desk_runs_status_check;
alter table desk_runs add constraint desk_runs_status_check check (status in ('running', 'done', 'error', 'timeout'));
