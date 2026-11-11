-- db/cron/schedule.sql: the job schedule, run inside the project's Supabase Postgres.
--
-- Deployment-specific scheduling, not schema: this directory is NOT under db/migrations and
-- `bun run db:migrate` never runs it. Apply it by hand (Supabase SQL editor, or psql as
-- `postgres`) whenever it changes; it is idempotent, so re-running it is the update path.
-- README.md "Scheduling" has the steps; db/cron/unschedule.sql turns everything off.
--
-- How it works: pg_cron fires `select ops.call_cron(job, path)` at the minutes below. The
-- helper reads the API origin and the cron token from Supabase Vault (secret names
-- `hypertrade_app_url` and `hypertrade_cron_token`; neither value appears in this file or in
-- cron.job.command), queues an authenticated POST with pg_net and logs the request id in
-- ops.cron_calls, which is what lets ops.cron_status join a job to its HTTP answer.
--
-- Timeout: 310 s, longer than the Vercel function limit (maxDuration 300 in api/index.ts), so
-- the real status (200/500, or Vercel's 504 on a kill) lands in net._http_response. pg_net's
-- worker sends a batch of queued requests and waits for all of them before it takes the next
-- batch, so a job queued while another is in flight waits for it: jobs on different minutes
-- run one after another, which is what the Vercel instance's small DB pool needs (see the
-- comment on the lab job in .github/workflows/collect.yml). Two jobs on the same minute would
-- share a batch and run side by side, so every HTTP job here has its own minute
-- (src/server/routes/cronSchedule.test.ts checks this). Without the long timeout the status
-- would read "timed out" after pg_net's default 5 s although the function keeps running
-- (Vercel does not cancel a function when its caller disconnects unless supportsCancellation
-- is set, and vercel.json does not set it).
--
-- Token exposure (checked 2026-11 against pg_net's sql/pg_net.sql and Supabase's troubleshooting notes "Database
-- roles can read request headers queued by pg_net" and "Revoking access to pg_net objects has no effect"):
--   * pg_net grants usage on schema net and all on its tables to PUBLIC. A queued request's headers, x-cron-token
--     included, are in net.http_request_queue from net.http_post until the worker takes its batch (it deletes the
--     rows as it reads them, src/core.c); with the batching above that can be a whole in-flight job, up to ~5 min.
--     net._http_response keeps the response's headers and body, never the request's.
--   * Nothing on net is revoked here, on purpose: Supabase installs pg_net as supabase_admin, so a revoke run as
--     postgres removes nothing ("no privileges could be revoked"), and Supabase says removing the PUBLIC grants
--     would break pg_net for postgres-owned pg_cron jobs and Database Webhooks.
--   * Residual exposure, precisely: any session that can log in to the database can read the token while a call
--     waits in the queue: postgres (which can read Vault anyway), the Supabase-internal login roles
--     (supabase_admin, supabase_read_only_user, pgbouncer, authenticator) and any login role created later.
--     anon and authenticated cannot log in; they reach SQL only through the Data API, which exposes `public` and
--     `graphql_public` by default, not `net`. They could read the queue only if `net` were added to the exposed
--     schemas or an exposed view or function read it, so never do either; the check at the end of this file fails
--     if a view outside net/ops reads the net tables.
--   * The token is never in cron.job.command, cron.job_run_details or ops.cron_calls: the job command names only the
--     job and path, the helper reads the token from Vault and puts it only in the pg_net header, no error message
--     carries it, and ops.cron_status selects no header column. The end-of-file check fails if that ever changes.

begin;

-- Supabase installs pg_cron into pg_catalog (schema `cron`) and pg_net into `extensions`
-- (its objects live in schema `net`). Both are in shared_preload_libraries already.
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;
create extension if not exists supabase_vault;

-- Private schema: PostgREST exposes `public`, not `ops`, and every grant below is revoked.
create schema if not exists ops;

-- One row per request this schedule queued. The pg_net request id is the key into
-- net._http_response (kept 6 hours there; pg_net.ttl). `body` keeps only a collect replay.
create table if not exists ops.cron_calls (
  id bigint primary key,
  job text not null,
  path text not null,
  body jsonb,
  called_at timestamptz not null default now()
);
create index if not exists cron_calls_job_id on ops.cron_calls (job, id desc);
alter table ops.cron_calls enable row level security;

-- Queue one authenticated POST to the app and return the pg_net request id.
-- Runs as the job owner (postgres) under pg_cron, so it needs no security definer.
create or replace function ops.call_cron(job text, path text)
returns bigint
language plpgsql
set search_path = pg_catalog
as $$
declare
  base text;
  token text;
  body jsonb := '{}'::jsonb;
  replay jsonb;
  prev record;
  request_id bigint;
begin
  if path !~ '^/api/[a-z0-9/_-]+$' then
    raise exception 'ops.call_cron: bad path %', path;
  end if;
  select rtrim(decrypted_secret, '/') into base from vault.decrypted_secrets where name = 'hypertrade_app_url';
  select decrypted_secret into token from vault.decrypted_secrets where name = 'hypertrade_cron_token';
  if coalesce(base, '') = '' or coalesce(token, '') = '' then
    raise exception 'ops.call_cron: vault secrets hypertrade_app_url and hypertrade_cron_token must both be set';
  end if;

  -- Collect spill replay (src/server/collectors/batch.ts), the job the Actions cache did in
  -- collect.yml: rows the database could not take come back in the answer's `spill` and are
  -- sent as `{replay}` next time. The server answered (body has `flush`): its spill, or none,
  -- replaces ours. No answer (timeout, error, not JSON, or pruned after 6 h): send again what
  -- the previous call sent.
  if path = '/api/cron/collect' then
    select c.body as sent, r.content into prev
    from ops.cron_calls c
    left join net._http_response r on r.id = c.id
    where c.path = '/api/cron/collect'
    order by c.id desc
    limit 1;
    if found then
      if prev.content is not null and pg_input_is_valid(prev.content, 'jsonb') and (prev.content::jsonb ? 'flush') then
        replay := prev.content::jsonb -> 'spill';
      else
        replay := prev.sent -> 'replay';
      end if;
      if jsonb_typeof(replay) = 'object' then
        body := jsonb_build_object('replay', replay);
      end if;
    end if;
  end if;

  request_id := net.http_post(
    url := base || path,
    body := body,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-token', token),
    timeout_milliseconds := 310000
  );
  insert into ops.cron_calls (id, job, path, body)
  values (request_id, job, path, case when body = '{}'::jsonb then null else body end);
  return request_id;
end
$$;

-- Daily housekeeping: cron.job_run_details and ops.cron_calls grow forever otherwise.
create or replace function ops.cron_cleanup()
returns void
language sql
set search_path = pg_catalog
as $$
  delete from cron.job_run_details where end_time < now() - interval '7 days';
  delete from ops.cron_calls where called_at < now() - interval '7 days';
$$;

-- Monitoring: last run and last HTTP answer per job. No header column of pg_net's tables is selected.
--   select * from ops.cron_status;
-- http_status null with pending = true: queued or in flight (the answer is visible once
-- pg_net's batch commits). null with pending = false: the answer is older than pg_net.ttl.
create or replace view ops.cron_status as
select
  j.jobname,
  j.schedule,
  j.active,
  d.status as last_run,
  d.start_time as last_run_at,
  case when d.status = 'failed' then d.return_message end as run_error,
  c.path,
  c.called_at,
  r.status_code as http_status,
  r.timed_out,
  r.error_msg,
  (c.id is not null and r.id is null and c.called_at > now() - interval '6 hours') as pending,
  left(r.content, 300) as response_head
from cron.job j
left join lateral (
  select * from cron.job_run_details x where x.jobid = j.jobid order by x.runid desc limit 1
) d on true
left join lateral (
  select * from ops.cron_calls x where x.job = j.jobname order by x.id desc limit 1
) c on true
left join net._http_response r on r.id = c.id
where j.jobname like 'hypertrade-%'
order by j.jobname;

-- Nobody but the owner (postgres) touches ops: not PUBLIC, not the PostgREST roles.
revoke all on schema ops from public, anon, authenticated, service_role;
revoke all on all tables in schema ops from public, anon, authenticated, service_role;
revoke all on all functions in schema ops from public, anon, authenticated, service_role;

-- The schedule. Edit the switches, then re-run the whole file.
--   intel_enabled: /api/cron/intel/{ingest,brief,graph,watch}; collect.yml ran them only with the
--     repository variable INTEL_ENABLED=true (unset when this moved: the intel job was skipped).
--   desk_enabled: /api/desk/tick; collect.yml ran it only with DESK_ENABLED=true (set: it ran).
-- Each 15-minute quarter: collect :00, backfill :02, platform tick :04, moves agent :07, desk :09,
-- intel ingest :12. Hourly jobs take free minutes. No two HTTP jobs share a minute.
-- novelty :10 and :40 sits in the gap before a collect, so even a call that runs to its hard stop (240 s) ends before
-- :15 / :45; each call checks coins for ~200 s and stores where it got to, and a full daily pass takes several calls.
do $$
declare
  intel_enabled constant boolean := false;
  desk_enabled  constant boolean := true;
  j record;
  keep text[] := array['hypertrade-cleanup'];
begin
  for j in
    select * from (values
      -- name                         cron expression        path                          switch
      ('hypertrade-collect',          '0,15,30,45 * * * *',  '/api/cron/collect',          'on'),
      ('hypertrade-backfill',         '2,17,32,47 * * * *',  '/api/cron/backfill',         'on'),
      ('hypertrade-platform-tick',    '4,19,34,49 * * * *',  '/api/cron/platform-tick',    'on'),
      ('hypertrade-moves',            '5 * * * *',           '/api/cron/moves',            'on'),
      ('hypertrade-moves-agent',      '7,22,37,52 * * * *',  '/api/cron/moves-agent',      'on'),
      ('hypertrade-desk-tick',        '9,24,39,54 * * * *',  '/api/desk/tick',             'desk'),
      ('hypertrade-novelty',          '10,40 * * * *',       '/api/cron/novelty',          'on'),
      ('hypertrade-intel-ingest',     '12,27,42,57 * * * *', '/api/cron/intel/ingest',     'intel'),
      ('hypertrade-intel-brief',      '14 * * * *',          '/api/cron/intel/brief',      'intel'),
      ('hypertrade-lab-collect',      '26 * * * *',          '/api/cron/lab-collect',      'on'),
      ('hypertrade-intel-graph',      '29 * * * *',          '/api/cron/intel/graph',      'intel'),
      ('hypertrade-intel-watch',      '44 * * * *',          '/api/cron/intel/watch',      'intel')
    ) as t(name, expr, path, switch)
  loop
    if j.switch = 'on' or (j.switch = 'desk' and desk_enabled) or (j.switch = 'intel' and intel_enabled) then
      perform cron.schedule(j.name, j.expr, format('select ops.call_cron(%L, %L)', j.name, j.path));
      keep := keep || j.name;
    end if;
  end loop;
  -- Jobs switched off, renamed or removed above stop here.
  for j in select jobname from cron.job where jobname like 'hypertrade-%' and not (jobname = any(keep)) loop
    perform cron.unschedule(j.jobname);
  end loop;
end
$$;

select cron.schedule('hypertrade-cleanup', '33 3 * * *', 'select ops.cron_cleanup()');

-- The token must not leak outside Vault and the pg_net header (see the header of this file). Fails the transaction.
do $$
declare
  token text := (select decrypted_secret from vault.decrypted_secrets where name = 'hypertrade_cron_token');
  leak text;
begin
  if coalesce(token, '') <> '' then
    select 'cron.job ' || jobname into leak from cron.job where strpos(command, token) > 0 limit 1;
    if leak is null then
      select 'cron.job_run_details ' || runid into leak from cron.job_run_details
      where strpos(command, token) > 0 or strpos(coalesce(return_message, ''), token) > 0 limit 1;
    end if;
    if leak is null then
      select 'ops.cron_calls ' || id into leak from ops.cron_calls where strpos(coalesce(body::text, ''), token) > 0 limit 1;
    end if;
    if leak is not null then
      raise exception 'the cron token appears in %: rotate it (README "Scheduling") and remove the row', leak;
    end if;
  end if;
  select format('%I.%I', v.relnamespace::regnamespace, v.relname) into leak
  from pg_depend d
  join pg_rewrite w on w.oid = d.objid
  join pg_class v on v.oid = w.ev_class
  where d.classid = 'pg_rewrite'::regclass and d.refobjid in ('net.http_request_queue'::regclass, 'net._http_response'::regclass)
    and v.relnamespace not in ('net'::regnamespace, 'ops'::regnamespace)
  limit 1;
  if leak is not null then
    raise exception 'view % reads pg_net''s tables outside ops: it could expose queued request headers', leak;
  end if;
end
$$;

commit;

-- Check: every job, its last run and its last HTTP status.
select jobname, schedule, active, last_run, http_status, pending from ops.cron_status;
