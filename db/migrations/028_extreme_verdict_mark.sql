-- Extreme verdicts graded and approvable (src/shared/extremes.ts ExtremeRecord; docs/EXTREMES.md § Grading):
-- `verdict_mark` is the live mark stamped when the verdict was stored (every stance; null when no fresh mark was
-- available, and on rows answered before this migration). `opportunity_id` is the platform opportunity a `take`
-- became (src/server/extremes/opportunity.ts), written once; null otherwise. No foreign key: the extremes row and its
-- verdict must survive whatever happens to the opportunity row. Apply after 027; safe to re-run.

alter table extreme_events add column if not exists verdict_mark double precision check (verdict_mark > 0);
alter table extreme_events add column if not exists opportunity_id uuid;
