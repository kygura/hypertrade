-- db/cron/unschedule.sql: turn off every job db/cron/schedule.sql scheduled.
-- Deployment-specific, not a migration (see the header of schedule.sql). Idempotent.
-- To turn off one job instead: select cron.unschedule('hypertrade-desk-tick');
-- (re-running schedule.sql brings it back unless its switch there is off).

-- Every job is named hypertrade-*: collect, backfill, platform-tick, moves, moves-agent, desk-tick, novelty, the intel
-- jobs, lab-collect and cleanup (src/server/routes/cronSchedule.test.ts checks the prefix).
select cron.unschedule(jobname) from cron.job where jobname like 'hypertrade-%';

-- Optional, to remove the helper, the call log and the status view too. The Vault secrets and
-- the pg_cron / pg_net extensions stay; Supabase features may use them.
-- drop schema ops cascade;
