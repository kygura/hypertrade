-- Platform gate amendments (SPEC.md § Platform P0.11, P0.13, 2026-10-16):
-- terminal status 'failed', and at most one outcome entry per
-- (opportunity, horizon). Apply after 011; safe to re-run.

-- 011 declared the status check inline, so Postgres named it opportunities_status_check.
alter table opportunities drop constraint if exists opportunities_status_check;
alter table opportunities add constraint opportunities_status_check
  check (status in ('new', 'investigating', 'calculated', 'ready', 'approved', 'rejected', 'expired', 'open', 'closed', 'failed'));

-- store appendLedger inserts outcomes with ON CONFLICT DO NOTHING against this.
create unique index if not exists ledger_entries_outcome_once on ledger_entries (opportunity_id, (payload->>'horizon'))
  where kind = 'outcome';
