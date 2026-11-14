-- Extremes calibration runs (src/server/extremes/calibrate.ts; docs/EXTREMES.md § Calibration pipeline): one row per
-- `bun run extremes calibrate` run (weekly workflow .github/workflows/extremes-calibrate.yml, or by hand). `result` is
-- the zod-parsed ExtremeCalibrationResult (per kind: rate before and after, multiplier, why unchanged, forward
-- returns for information), `thresholds` the ExtremeThresholds the run proposes. The live job applies the thresholds
-- of the newest row with `applied` true (parsed again on the way out; a row that fails to parse falls back to the
-- code defaults); no applied row means the code defaults. `coins` is the replayed universe as a jsonb list (db.ts runs
-- with fetch_types off: no array params). Apply after 028; safe to re-run.

create table if not exists extreme_calibrations (
  id          bigserial   primary key,
  ran_at      timestamptz not null,
  window_from timestamptz,
  window_to   timestamptz,
  coins       jsonb       not null,
  result      jsonb       not null,
  thresholds  jsonb       not null,
  applied     boolean     not null default false
);
create index if not exists extreme_calibrations_applied on extreme_calibrations (applied, ran_at desc, id desc);

-- 022_enable_rls.sql: every public table has RLS on (no policies: the app's role bypasses it).
alter table extreme_calibrations enable row level security;
