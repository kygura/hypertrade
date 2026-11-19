-- The living regime thesis (src/server/regime/store.ts; docs/REGIME.md). `bun run regime update` (the Regime workflow,
-- or by hand) writes one row in regime_theses per version and one changelog row in regime_history; a seed adds older
-- changelog rows (version 0). `doc` and `entry` are the zod-checked RegimeThesis / HistoryEntry, parsed again on the
-- way out (a row that fails to parse is skipped). The current thesis is the newest saved_at. regime_seen holds the
-- report and note ids already read, so a report counts as new once; regime_lock holds one row while a rewrite runs
-- (taken over after 10 minutes). The store prunes to the last 60 versions and 400 changelog rows. Apply after 029;
-- safe to re-run.

create table if not exists regime_theses (
  id       text        primary key,
  version  integer     not null,
  created  timestamptz not null,
  saved_at timestamptz not null default now(),
  doc      jsonb       not null
);
create index if not exists regime_theses_saved on regime_theses (saved_at desc, version desc);

create table if not exists regime_history (
  id      text        primary key,
  created timestamptz not null,
  entry   jsonb       not null
);
create index if not exists regime_history_created on regime_history (created desc, id desc);

create table if not exists regime_seen (
  key     text        primary key,
  seen_at timestamptz not null
);

create table if not exists regime_lock (
  name       text        primary key,
  started_at timestamptz not null
);

-- 022_enable_rls.sql: every public table has RLS on (no policies: the app's role bypasses it).
alter table regime_theses enable row level security;
alter table regime_history enable row level security;
alter table regime_seen enable row level security;
alter table regime_lock enable row level security;
