-- The full rule behind a trial, so an authored idea can be re-screened later. Older rows stay null.
alter table lab_trials add column if not exists rule jsonb;
